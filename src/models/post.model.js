import mongoose, { Schema, model } from "mongoose";
import slugify from "../utils/slugify.js";
import { type } from "node:os";

const postSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    content: {
      type: String,
      required: true,
    },

    author: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["draft", "published"],
      default: "draft",
      index: true,
    },

    stats: {
      views: { type: Number, default: 0 },
      likes: { type: Number, default: 0 },
      commentCount: { type: Number, default: 0 },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Virtual: Excerpt
postSchema.virtual("excerpt").get(function () {
  if (!this.content) return "";
  return this.content.substring(0, 200);
});

// Virtual: Reading time
postSchema.virtual("ReadingTime").get(function () {
  if (!this.content) return 0;
  const words = this.content.trim().split(/\s+/).length;
  return Math.ceil(words / 200);
});

// Pre Hook: generate slug
postSchema.pre("save", async function (next) {
  if (!this.isModified("title")) return next();

  const baseSlug = slugify(this.title);

  const existing = await mongoose.model.Post.findOne({
    slug: baseSlug,
  });

  if (existing) {
    this.slug = `${baseSlug}-${Date.now()}`;
  } else {
    this.slug = baseSlug;
  }
  next();
});

// Increment post count
postSchema.post("save", async function (doc, next) {
  if (doc.status === "published") {
    await mongoose.model("User").updateOne(
      {
        _id: doc.author,
      },
      {
        $inc: { "stats.postCount": 1 },
      },
    );
  }
  next();
});

export const Post = model("Post", postSchema);
