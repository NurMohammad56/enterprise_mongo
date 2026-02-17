import { Schema, model } from "mongoose";

const commentSchema = new Schema(
  {
    content: {
      type: String,
      required: true,
      trim: true,
    },

    post: {
      type: Schema.Types.ObjectId,
      ref: "Post",
      required: true,
      index: true,
    },

    author: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    parentComment: {
      type: Schema.Types.ObjectId,
      ref: "Comment",
      index: true,
      default: null,
    },

    isHidden: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Virtual: nested level
commentSchema.virtual("deept").get(function () {
  if (!this.parentComment) return 0;

  return 1;
});

function excludeHidden(next) {
  this.where({ isHidden: false });
  next();
}

commentSchema.pre("find", excludeHidden);
commentSchema.pre("findOne", excludeHidden);

commentSchema.post("save", async function (doc, next) {
  await mongoose.model("Post").updateOne(
    {
      _id: doc.post,
    },
    {
      $inc: { "stats.commentCount": 1 },
    },
  );
  next();
});

export const Comment = model("Comment", commentSchema);
