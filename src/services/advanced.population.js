import mongoose from "mongoose";
import { match } from "node:assert";

export const dynamicPopulate = (model, id, populateOptions) => {
  let query = model.findById(id);

  populateOptions.forEach((option) => {
    query = query.populate(option);
  });
  return query.lean();
};

// Usage:
// const post = await dynamicPopulate(Post, postId, [
//     'author',
//     'categories',
//     'comments.author'
// ]);

export const getPostWithOptional = async (postId, options = {}) => {
  let query = Post.findById(postId);

  if (options.includeAuthor) {
    query = query.populate({
      path: "author",
      select: "username avatar",
    });
  }

  if (options.includeCategories) {
    query = query.populate({
      path: "categories",
      select: "name slug -_id ",
      match: options.categoryFilter || {},
    });
  }

  if (options.includeComments) {
    query = query.populate({
      path: "comments",
      match: { isHidden: false },
      options: { sort: { createdAt: -1 }, limit: 10 },
      populate: options.includeCommentsAuthor
        ? {
            path: "author",
            select: "username avatar",
          }
        : null,
    });
  }

  return query.lean();
};

export const batchPopulate = async (documents, populateConfig) => {
  const result = [...documents];

  for (const config of populateConfig) {
    const Model = mongoose.model(config.model);

    // Collect ALL ids
    const allIds = documents.flatMap((doc) => doc[config.localField] || []);

    const uniqueIds = [...new Set(allIds.map((id) => id.toString()))];

    const populatedData = await Model.find({
      _id: { $in: uniqueIds },
    })
      .select(config.select)
      .lean();

    const dataMap = new Map(
      populatedData.map((item) => [item._id.toString(), item]),
    );

    // Map back
    result.forEach((doc) => {
      doc[config.localField] = (doc[config.localField] || []).map((id) =>
        dataMap.get(id.toString()),
      );
    });
  }

  return result;
};
