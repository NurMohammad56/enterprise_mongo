import mongoose from "mongoose";

const followSchema = new mongoose.Schema(
  {
    followerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    followingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

export const Follow = mongoose.model("Follow", followSchema);
