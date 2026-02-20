import { User } from "../models/user.model.js";

export const getUserWithProfileOptimized = async (userId) => {
  try {
    const user = await User.find({ _id: userId })
      .populate({
        path: "profile",
        select: "bio avatarUrl -_id",
        options: { lean: true },
      })
      .lean();

    return user;
  } catch (error) {
    throw error;
  }
};

export const getUserWithPostsOptimized = async (userId) => {
  try {
    const user = await User.findById(userId)
      .populate({
        path: "posts",
        options: {
          sort: { createdAt: -1 },
          limit: 10,
        },
        populate: {
          path: "categories",
          select: "name -_id",
        },
      })
      .lean();

    return user;
  } catch (error) {
    throw error;
  }
};

export const getMultipleUsersWithPostsOptimized = async (userIds) => {
  try {
    const users = await User.find({ _id: { $in: userIds } })
      .populate({
        path: "posts",
        match: { status: "published" },
        options: {
          sort: { createdAt: -1 },
          limit: 10,
        },
        populate: {
          path: "categories",
          select: "name -_id",
        },
      })
      .lean();

    return users;
  } catch (error) {}
};

export const getUserPostWithPaginated = async (
  userId,
  page = 1,
  limit = 10,
) => {
  try {
    const user = await User.findById(userId).populate({
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
    }).lean();

    return {
        post: user.posts,
        pagination: {
            currentPage: page,
            pageSize: limit,
            totalPosts: user.posts.length,
            haseMore: user.posts.length > page * limit,
        }
    }
  } catch (error) {
    throw error;
  }
};
