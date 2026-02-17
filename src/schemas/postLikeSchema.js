import mongoose from "mongoose";

const likeSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    postId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      index: true,
    },
  },
  { timestamps: true },
);

export const PostLike = mongoose.model("PostLike", likeSchema);
