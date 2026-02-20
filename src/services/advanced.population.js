import mongoose from "mongoose";
import { match } from "node:assert";

export const dynamicPopulate = (model, id, populateOptions) => {
  let query = model.findById(id);

  populateOptions.forEach((path) => {
    query = query.populate(path);
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
  const populateDocs = [];

  for (const doc of documents) {
    let populateDoc = doc;

    for (const config of populateConfig) {
      const Model = mongoose.model(config.model);
      const populatedData = await Model.find({
        _id: { $in: doc[config.localField] },
      })
        .select(config.select)
        .lean();

      populateDoc[config.localField] = populatedData;
    }

    populateDocs.push(populateDoc);
  }

  return populateDocs;
};
