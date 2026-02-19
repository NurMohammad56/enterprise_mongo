import { Post } from "../models/post.model.js";
import { Category } from "../models/category.model.js";

export const getPostWithCategory = async (postId) => {
  try {
    const post = await Post.findById(postId)
      .populate({
        path: "categories",
        select: "name -_id",
        options: { sort: { name: 1 } },
      })
      .lean();

    return post;
  } catch (error) {
    throw error;
  }
};

export const getCategoryWithPosts = async (
  categoryId,
  page = 1,
  limit = 10,
) => {
  try {
    const category = await Category.findById(categoryId)
      .populate({
        path: "posts",
        options: {
          sort: { createdAt: -1 },
          skip: (page - 1) * limit,
          limit: limit,
        },
        populate: {
          path: "author",
          select: "username",
        },
      })
      .lean();

    return category;
  } catch (error) {
    throw error;
  }
};

export const getPostWithEvrything = async (postId) => {
  try {
    const post = await Post.findById(postId)
      .populate([
        {
          path: "author",
          select: "username",
        },
        {
          path: "categories",
          select: "name -_id",
          options: { sort: { name: 1 } },
        },
        {
          path: "comments",
          select: "content -_id",
          match: { isHidden: false },
          options: { sort: { createdAt: -1 }, limit: 10 },

          populate: {
            path: "author",
            select: "username",
          },
        },
      ])
      .lean();

    return post;
  } catch (error) {}
};
