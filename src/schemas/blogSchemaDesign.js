import mongoose from "mongoose";
import { settings } from "node:cluster";

class BlogSchemaDesign {
  // User Schema
  static getUserSchema() {
    return {
      // Primary fields
      username: { type: String, required: true, unique: true, index: true },
      email: { type: String, required: true, unique: true, index: true },

      // Embedded fields
      profile: {
        firstName: { type: String },
        lastName: { type: String },
        bio: { type: String },
        avatar: { type: String },
        location: { type: String },
        website: { type: String },
      },

      // Embedded stats
      stats: {
        posts: { type: Number, default: 0 },
        followers: { type: Number, default: 0 },
        following: { type: Number, default: 0 },
        likes: { type: Number, default: 0 },
        comments: { type: Number, default: 0 },
        lastActive: { type: Date, default: Date.now },
      },

      // References (with limits)
      recentPost: {
        type: [
          {
            postId: { type: mongoose.Schema.Types.ObjectId, ref: "Post" },
            title: { type: String },
            slug: { type: String },
            createdAt: { type: Date, default: Date.now },
          },
        ],
        validate: [(arr) => arr.length <= 10, "Max 10 recent posts allowed"],
      },
      // Following/Follwers
      following: [
        {
          userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
          followedAt: { type: Date, default: Date.now },
        },
      ],

      follwers: [
        {
          userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
          followedAt: { type: Date, default: Date.now },
        },
      ],

      // Settings
      settings: {
        theme: { type: String, default: "light" },
        language: { type: String, default: "en" },
      },
    };
  }

  // Post Schema
  static getPostSchema() {
    return {
      // Primary fields
      title: { type: String, required: true, index: true },
      slug: { type: String, required: true, unique: true, index: true },
      content: {
        type: String,
        required: true,
        index: true,
        validate: {
          validator: function (v) {
            return v.length >= 100 && v.length <= 10000;
          },
          message: "Content must be between 100 and 10000 characters",
        },
      },

      // Embedded fields
      author: {
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          index: true,
        },
        username: String,
        avatar: String,
      },

      // Category and tags
      category: {
        type: String,
        enum: ["news", "tutorials", "reviews", "opinions"],
        index: true,
      },
      tags: [
        {
          type: String,
          lowercase: true,
          trim: true,
          validate: {
            validator: function (v) {
              // 1. Length validation
              if (v.length < 2 || v.length > 30) return false;

              // 2. Character validation (alphanumeric + hyphen)
              if (!/^[a-z0-9-]+$/.test(v)) return false;

              // 3. Reserved words check
              const reserved = ["admin", "administrator", "moderator"];
              if (reserved.includes(v)) return false;

              // 4. No consecutive hyphens
              if (v.includes("--")) return false;

              // 5. No leading/trailing hyphens
              if (v.startsWith("-") || v.endsWith("-")) return false;

              return true;
            },
            message: "Invalid tag format",
          },
        },
      ],

      // Status and scheduling
      status: {
        type: String,
        enum: ["draft", "published", "scheduled"],
        default: "draft",
        index: true,
      },
      publisedAt: {
        type: Date,
        index: true,
      },
      scheduler: {
        type: Date,
      },

      // SEO
      seo: {
        title: String,
        description: String,
        keywords: String,
        canonicalUrl: String,
      },

      coverImage: String,
      images: [String],

      // References (limite)
      comments: [
        {
          commentId: { type: mongoose.Schema.Types.ObjectId, ref: "Comment" },
          author: String,
          excerpt: String,
          createdAt: { type: Date, default: Date.now },
        },
      ],

      likes: [
        {
          userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
          likedAt: { type: Date, default: Date.now },
        },
      ],

      // Versioning
      version: {
        type: Number,
        default: 1,
      },
      previousVersions: [
        {
          content: String,
          updatedAt: { type: Date, default: Date.now },
          version: Number,
        },
      ],

      // Audit trail
      cratedBy: {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      },
      updatedBy: {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      },
      createdAt: { type: Date, default: Date.now, index: true },
      updatedAt: { type: Date, default: Date.now, index: true },
    };
  }

  // Comment Schema
  static getCommentSchema() {
    return {
      content: { type: String, required: true },

      // References with denormalization
      post: {
        postId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Post",
          index: true,
        },
        title: { type: String },
        slug: { type: String },
      },

      author: {
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          index: true,
        },
        username: String,
        avatar: String,
      },

      // Threading support
      parentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Comment",
        index: true,
      },
      rootId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Comment",
        index: true,
      },

      ancestors: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Comment",
          index: true,
        },
      ],

      depth: {
        type: Number,
        default: 0,
        index: true,
      },

      // Embedded replies
      recentReplies: [
        {
          commentId: { type: mongoose.Schema.Types.ObjectId, ref: "Comment" },
          author: String,
          excerpt: String,
          createdAt: { type: Date, default: Date.now },
        },
      ],
      replyCount: {
        type: Number,
        default: 0,
      },

      // Engagment
      likes: [{ type: Number, default: 0 }],
      likedBy: [
        {
          userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
          likedAt: { type: Date, default: Date.now },
        },
      ],

      // Moderation
      isHidden: {
        type: Boolean,
        default: false,
      },
      hiddenAt: {
        type: Date,
        default: null,
      },
      reportedCount: {
        type: Number,
        default: 0,
      },
      moderateNotes: String,
      createdAt: { type: Date, default: Date.now, index: true },
    };
  }
}
