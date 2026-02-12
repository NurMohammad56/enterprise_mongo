import mongoose, { connections } from "mongoose";
import winston from "winston";
import EventEmitter from "events";
import { parse } from "path";
import { write } from "fs";

class DatabaseManager extends EventEmitter {
  constructor() {
    super();
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxRetries = 5;
    this.retryDelay = 2000;
    this.connectionCheckInterval = null;
    this.metrics = {
      totalQueries: 0,
      failedQueries: 0,
      avgQueryTime: 0,
      connections: 0,
    };

    // Set up mongoose plugin
    this.setupMongoose();
  }

  // Set up mongoose
  setupMongoose() {
    mongoose.set("strictQuery", true);
    mongoose.set("toJSON", { virtuals: true, transform: this.transformJSON });
    mongoose.set("toObject", { virtuals: true });

    // Set up plugins
    this.setupGlobalPlugins();

    // Setup query middleware for monitoring
    this.setupQueryMiddleware();

    // Setup connection event handlers
    this.setupConnectionEvents();
  }

  // Set up global plugins
  setupGlobalPlugins() {
    // timestamp plugin
    const timestampPlugin = (schema) => {
      schema.add({
        createdAt: {
          type: Date,
          default: Date.now,
          index: true,
        },
        updatedAt: {
          type: Date,
          default: Date.now,
          index: true,
        },
        deletedAt: {
          type: Date,
          default: null,
        },
      });

      schema.pre("save", function (next) {
        if (this.isNew) {
          this.createdAt = new Date();
        }
        this.updatedAt = new Date();
        next();
      });

      schema.pre(
        ["updateOne", "updateMany", "findOneAndUpdate"],
        function (next) {
          this.set({ updatedAt: new Date() });
          next();
        },
      );
    };

    const softDeletePlugin = (schema) => {
      schema.add({
        isDeleted: {
          type: Boolean,
          default: false,
        },
        deletedAt: {
          type: Date,
          default: null,
          index: true,
        },
      });

      schema.pre(/^find/, function (next) {
        if (this.getQuery().isDeleted) {
          this.where({ deletedAt: null });
        }
        next();
      });

      schema.statics.softDelete = async function (query) {
        return this.updateMany(query, {
          isDeleted: true,
          deletedAt: new Date(),
        });
      };

      schema.statics.restore = async function (query) {
        return this.updateMany(query, {
          isDeleted: false,
          deletedAt: null,
        });
      };
    };

    // Add plugins
    mongoose.plugin(timestampPlugin);
    mongoose.plugin(softDeletePlugin);
  }

  // Query middleware for monitoring performance
  setupQueryMiddleware() {
    mongoose.set("debug", (collectionName, method, query, doc) => {
      const queryStr = JSON.stringify(query);
      const startTime = Date.now();

      const logSlowQuery = () => {
        const duration = Date.now() - startTime;
        if (
          duration >
          parseInt(
            (process.env.MONGODB_SLOW_QUERY_THRESHOLD =
              100 || // Log queries >100ms
              100),
          )
        ) {
          winston.warn("SLOW_QUERY", {
            collection: collectionName,
            method,
            query: queryStr,
            duration,
            thresHold: process.env.MONGODB_SLOW_QUERY_THRESHOLD,
          });
        }

        // Update Matrices
        this.metrics.totalQueries += 1;
        this.metrics.avgQueryTime =
          (this.metrics.avgQueryTime * (this.metrics.totalQueries - 1) +
            duration) /
          this.metrics.totalQueries;
      };

      process.nextTick(logSlowQuery);
    });

    mongoose.Query.prototype.setOptions = function (options) {
      const result = mongoose.Query.prototype.setOptions.apply(this, arguments);

      if (!this.options.maxTimeMS) {
        this.options.maxTimeMS = process.env.MONGODB_QUERY_TIMEOUT || 10000;
      }

      if (!this.options.readPerformace) {
        this.options.readPerformace =
          process.env.MONGODB_READ_PERFORMANCE || "primary";
      }

      return result;
    };
  }

  // Connection event handlers
  setupConnectionEvents() {
    mongoose.connection.on("connected", () => {
      this.isConnected = true;
      this.connectionAttempts = 0;
      winston.info("MONGODB_CONNECTED");
      this.emit("connected");

      this.startHealthCheck();
    });

    mongoose.connection.on("error", (error) => {
      winston.error("MONGODB_ERROR", error);
      this.emit("error", error);

      this.handleConnectionError();
    });

    mongoose.connection.on("disconnected", () => {
      this.isConnected = false;
      winston.info("MONGODB_DISCONNECTED");
      this.emit("disconnected");

      this.attemptReconnection();
    });

    mongoose.connection.on("reconnected", () => {
      winston.info("MONGODB_RECONNECTED");
      this.emit("reconnected");
    });
  }

  // Connect to database with production config
  async connect() {
    const connectionOptions = {
      maxPoolSize: parseInt(process.env.MONGODB_MAX_POOL_SIZE || 100),
      minPoolSize: parseInt(process.env.MONGODB_MIN_POOL_SIZE || 10),
      maxIdleTimeMS: parseInt(process.env.MONGODB_MAX_IDLE_TIME || 30000),

      socketTimeoutMS: parseInt(process.env.MONGODB_SOCKET_TIMEOUT || 45000),
      connectTimeoutMS: parseInt(process.env.MONGODB_CONNECT_TIMEOUT || 30000),

      serverSelectionTimeoutMS: 5000,

      w: process.env.MONGODB_WRITE_CONCERN || "majority",
      j: process.env.MONGODB_JOURNAL || "true",

      wtimeout: 10000,

      // Read preference
      readPreference: process.env.MONGODB_READ_PREFERENCE || "primary",

      // Retry logic
      retryWrites: true,
      retryReads: true,

      // Security
      tls: process.env.MONGODB_TLS === "true",
      sslValidate: process.env.MONGODB_SSL_VALIDATE === "true",
      authSource: process.env.MONGODB_AUTH_SOURCE || "admin",
    };

    try {
      winston.info("MONGODB_CONNECTING", {
        maxPoolSize: connectionOptions.maxPoolSize,
        readPreference: connectionOptions.readPreference,
        writeConcern: connectionOptions.w,
      });

      await mongoose.connect(process.env.MONGODB_URI, connectionOptions);

      await this.healthCheck();
    } catch (error) {
      winston.error("MONGODB_ERROR", error);
      throw new DatabaseConnectionError(
        `Failed to connect to MongoDB after ${this.connectionAttempts} attempts`,

        {
          cause: error,
        },
      );
    }
  }

  async healthCheck() {
    try {
      // 1. Ping Database
      await mongoose.connection.db.admin().ping();

      // 2. Check connection state
      const readyState = mongoose.connection.readyState;

      if (readyState !== 1) {
        throw new Error("Connection is not ready");
      }

      // 3. Get server status
      const status = await mongoose.connection.db.admin().serverStatus();

      // 4. Check replicaiton status
      if (status.repl) {
        const isPrimary = status.repl.ismaster;
        const isSecondary = status.repl.secondary;

        if (!isPrimary && !isSecondary) {
          throw new Error("Not connected to primary server or secondary");
        }
      }

      winston.debug("MongoDB health check passed");
      return {
        healthy: true,
        readyState,
        connections: status.connections.length,
        serverStatus: {
          version: status.version,
          ok: status.ok,
          uptime: status.uptime,
          connections: status.connections,
        },
      };
    } catch (error) {
      winston.error("MongoDB health check failed", error);
      return {
        healthy: false,
        error: error.message,
      };
    }
  }

  // Graceful Shutdown
  async disconnect() {
    try {
      if (this.connectionCheckInterval) {
        clearInterval(this.connectionCheckInterval);
      }

      await Promise.race([
        mongoose.connection.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 1000),
        ),
      ]);

      winston.info("MONGODB_DISCONNECTED GRACEFULLY");
    } catch (error) {
      winston.error("MONGODB_DISCONNECT_ERROR", error);
      throw error;
    }
  }

  // Get matrices
  getMatrices() {
    const poolStats = mongoose.connection.getClient().s.options;

    return {
      ...this.metrics,
      pool: {
        size: poolStats.maxPoolSize,
        available: mongoose.connections.length,
        used: this.metrics.connections,
      },
      state: {
        connected: this.isConnected,
        readyState: mongoose.connection.readyState,
      },
    };
  }

  // transformJSON
  transformJSON(doc, ret) {
    delete ret._id;
    delete ret.__v;

    if (doc._id) {
      ret.id = doc._id.toString();
    }

    if (ret.createdAt) ret.createdAt = ret.createdAt.toISOString();
    if (ret.updatedAt) ret.updatedAt = ret.updatedAt.toISOString();
    if (ret.deletedAt) ret.deletedAt = ret.deletedAt.toISOString();

    return ret;
  }

  // Handle connection errors with circuit breaker
  handleConnectionError() {
    this.connectionAttempts++;
    if (this.connectionAttempts >= this.maxRetries) {
      winston.error(
        "MONGODB_CONNECTION_ERROR",
        `Failed to connect to MongoDB after ${this.connectionAttempts} attempts`,
      );
      this.emit("circuitOpen");

      const delay =
        this.retryDelay *
        Math.pow(2, this.connectionAttempts - this.maxRetries);

      winston.info(`Circuit breaker will retry in ${delay}ms`);

      setTimeout(() => {
        this.connectionAttempts = 0;
        this.emit("circuitClose");
      }, delay);
    }
  }

  // Attampt reconnection
  attemptReconnection() {
    if (this.connectionAttempts >= this.maxRetries) return;

    const delay = this.retryDelay * Math.pow(2, this.connectionAttempts);

    winston.info(
      `Attempting reconnection in ${delay}ms (attempt ${this.connectionAttempts})`,
    );

    setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        winston.error(
          `Reconnecting attempt ${this.connectionAttempts + 1} failed`,
          error,
        );

        this.connectionAttempts++;
        this.attemptReconnection();
      }
    }, delay);
  }

  // Start health check
  startHealthCheck() {
    if (this.connectionCheckInterval) {
      clearInterval(this.connectionCheckInterval);
    }

    this.connectionCheckInterval = setInterval(async () => {
      const healthCheck = await this.healthCheck();

      if (!healthCheck.healthy) {
        winston.warn(`Periodic health check failed: ${healthCheck.error}`);
        this.emit("healthCheckFailed", healthCheck);
      }
    }, 30000);
  }
}

// Database connection error
class DatabaseConnectionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "DatabaseConnectionError";
    this.cause = options.cause;
    this.code = "DB_CONNECTION_ERROR";
    this.timestamp = new Date().toISOString();
  }
}

class DatabaseQueryError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "DatabaseQueryError";
    this.cause = options.cause;
    this.code = "DB_QUERY_ERROR";
    this.timestamp = new Date().toISOString();
    this.query = options.query;
  }
}

const databaseManager = new DatabaseManager();
module.exports = {
  databaseManager,
  DatabaseConnectionError,
  DatabaseQueryError,
  mongoose,
};
