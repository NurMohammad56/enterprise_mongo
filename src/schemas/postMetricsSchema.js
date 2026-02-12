import mongoose from "mongoose";

const postMetricsSchema = new mongoose.Schema({
  postId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Post",
    index: true,
  },

  date: { type: String, index: true }, // "2026-02-12"
  hour: { type: Number, index: true }, // 0-23

  views: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  shares: { type: Number, default: 0 },

  createdAt: {
    type: Date,
    default: Date.now,
    expires: "7d", // auto delete old metrics
  },
});

export const PostMetrics = mongoose.model("PostMetrics", postMetricsSchema);
