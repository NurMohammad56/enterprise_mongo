import { Schema, model } from "mongoose";

const postSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
    },
    content: {
      type: String,
      required: true,
    },

    author: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    categories: [
      {
        type: Schema.Types.ObjectId,
        ref: "Category",
      },
    ],

    metadata: {
      type: Schema.Types.ObjectId,
      ref: "Metadata",
    },
  },
  { timestamps: true },
);

export const Post = model("Post", postSchema);
