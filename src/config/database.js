import mongoose, { connections } from "mongoose";
import winston from "winston";
import EventEmitter from "events";

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
}
