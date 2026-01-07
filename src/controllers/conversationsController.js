/**
 * Conversations Controller
 * Handles conversation threads between users and owners
 */

const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const Owner = require("../models/Owner");
const { success, error, paginationMeta } = require("../utils/responseHelper");
const errorCodes = require("../utils/errorCodes");

/**
 * @desc    Get all conversations for a user
 * @route   GET /api/conversations
 * @access  Private
 */
exports.getUserConversations = async (req, res, next) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const validPage = Math.max(1, parseInt(page));
    const validLimit = Math.min(100, Math.max(1, parseInt(limit)));

    // Check if user is owner to fetch appropriate conversations
    const owner = await Owner.findOne({ user_id: req.user._id });

    let filter = {};
    if (owner) {
      // If user is an owner, get conversations where they are the owner
      filter.owner_id = owner._id;
    } else {
      // Otherwise, get conversations where they are the regular user
      filter.user_id = req.user._id;
    }

    // Get total count
    const total = await Conversation.countDocuments(filter);

    // Get conversations with pagination
    const conversations = await Conversation.find(filter)
      .populate("user_id", "email first_name last_name")
      .populate("owner_id", "business_name user_id")
      .populate("booking_id", "booking_number space_id")
      .sort({ last_message_at: -1 })
      .skip((validPage - 1) * validLimit)
      .limit(validLimit);

    // Get unread count for each conversation
    const conversationsWithUnread = await Promise.all(
      conversations.map(async (conv) => {
        const convObj = conv.toObject();

        // Determine who is the recipient to count unread messages
        let recipientFilter = {
          conversation_id: conv._id,
          is_read: false,
        };

        if (owner) {
          // Owner receives messages from users
          recipientFilter.sender_type = "User";
        } else {
          // User receives messages from owners
          recipientFilter.sender_type = "Owner";
        }

        const unreadCount = await Message.countDocuments(recipientFilter);
        convObj.unread_count = unreadCount;

        return convObj;
      })
    );

    const meta = paginationMeta(validPage, validLimit, total);

    return success(res, { conversations: conversationsWithUnread }, meta);
  } catch (err) {
    console.error("Get user conversations error:", err);
    return error(
      res,
      errorCodes.SERVER_ERROR,
      500,
      "Error fetching conversations"
    );
  }
};

/**
 * @desc    Get conversation by ID
 * @route   GET /api/conversations/:id
 * @access  Private/Participant
 */
exports.getConversationById = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Get conversation
    const conversation = await Conversation.findById(id)
      .populate("user_id", "email first_name last_name")
      .populate("owner_id", "business_name user_id")
      .populate("booking_id", "booking_number space_id");

    if (!conversation) {
      return error(res, errorCodes.NOT_FOUND, 404, "Conversation not found");
    }

    // Check authorization - user must be a participant
    const owner = await Owner.findOne({ user_id: req.user._id });
    const isParticipant =
      conversation.user_id._id.toString() === req.user._id.toString() ||
      (owner && conversation.owner_id._id.toString() === owner._id.toString());

    if (!isParticipant && req.user.user_type !== "admin") {
      return error(
        res,
        errorCodes.AUTH_FORBIDDEN,
        403,
        "Not authorized to view this conversation"
      );
    }

    // Get messages for this conversation
    const messages = await Message.find({ conversation_id: id })
      .sort({ created_at: 1 })
      .limit(50); // Get last 50 messages

    const conversationObj = conversation.toObject();
    conversationObj.messages = messages;

    return success(res, { conversation: conversationObj });
  } catch (err) {
    console.error("Get conversation by ID error:", err);
    return error(
      res,
      errorCodes.SERVER_ERROR,
      500,
      "Error fetching conversation"
    );
  }
};

/**
 * @desc    Create or get conversation
 * @route   POST /api/conversations
 * @access  Private
 */
exports.createConversation = async (req, res, next) => {
  console.log("[createConversation] Request received");
  console.log("[createConversation] User ID:", req.user?._id);
  console.log("[createConversation] User type:", req.user?.user_type);
  console.log("[createConversation] Request body:", JSON.stringify(req.body, null, 2));

  try {
    const { participant_id, booking_id } = req.body;
    const Booking = require("../models/Booking");

    console.log("[createConversation] Extracted data - participant_id:", participant_id, ", booking_id:", booking_id);

    let owner_id;

    // If booking_id is provided, get owner_id from the booking
    if (booking_id) {
      console.log("[createConversation] Looking up booking with ID:", booking_id);
      const booking = await Booking.findById(booking_id);

      if (!booking) {
        console.log("[createConversation] ERROR: Booking not found for ID:", booking_id);
        return error(res, errorCodes.NOT_FOUND, 404, "Booking not found");
      }
      console.log("[createConversation] Booking found - booking_number:", booking.booking_number);

      // Verify booking belongs to user
      console.log("[createConversation] Booking user_id:", booking.user_id.toString());
      console.log("[createConversation] Request user_id:", req.user._id.toString());
      if (booking.user_id.toString() !== req.user._id.toString()) {
        console.log("[createConversation] ERROR: Booking does not belong to user");
        return error(
          res,
          errorCodes.AUTH_FORBIDDEN,
          403,
          "Booking does not belong to you"
        );
      }

      // Get owner_id from the booking
      owner_id = booking.owner_id;
      console.log("[createConversation] Owner ID from booking:", owner_id);
    } else if (participant_id) {
      console.log("[createConversation] Looking up owner by participant_id:", participant_id);
      // Fallback: try to find owner by participant_id (could be owner_id or user_id)
      let owner = await Owner.findById(participant_id);
      if (!owner) {
        console.log("[createConversation] Owner not found by _id, trying user_id lookup");
        // participant_id might be a user_id, try to find owner by user_id
        owner = await Owner.findOne({ user_id: participant_id });
      }
      if (!owner) {
        console.log("[createConversation] ERROR: Owner not found for participant_id:", participant_id);
        return error(res, errorCodes.NOT_FOUND, 404, "Owner not found");
      }
      owner_id = owner._id;
      console.log("[createConversation] Owner found - owner_id:", owner_id);
    } else {
      console.log("[createConversation] ERROR: Neither booking_id nor participant_id provided");
      return error(
        res,
        errorCodes.BIZ_VALIDATION,
        400,
        "Either booking_id or participant_id is required"
      );
    }

    // Verify owner exists
    console.log("[createConversation] Verifying owner exists with ID:", owner_id);
    const owner = await Owner.findById(owner_id);
    if (!owner) {
      console.log("[createConversation] ERROR: Owner not found for ID:", owner_id);
      return error(res, errorCodes.NOT_FOUND, 404, "Owner not found");
    }
    console.log("[createConversation] Owner verified - business_name:", owner.business_name);

    // Check if conversation already exists between user and owner
    console.log("[createConversation] Checking for existing conversation - user_id:", req.user._id, ", owner_id:", owner_id);
    let conversation = await Conversation.findOne({
      user_id: req.user._id,
      owner_id: owner_id,
    })
      .populate("user_id", "email first_name last_name")
      .populate("owner_id", "business_name user_id")
      .populate("booking_id", "booking_number space_id");

    if (conversation) {
      console.log("[createConversation] Existing conversation found - conversation_id:", conversation._id);
      console.log("[createConversation] SUCCESS: Returning existing conversation");
      // Return existing conversation
      return success(res, { conversation, existing: true });
    }
    console.log("[createConversation] No existing conversation found");

    // Create new conversation
    console.log("[createConversation] Creating new conversation in database...");
    conversation = await Conversation.create({
      user_id: req.user._id,
      owner_id: owner_id,
      booking_id: booking_id || null,
      last_message_at: new Date(),
    });
    console.log("[createConversation] Conversation created with _id:", conversation._id);

    // Populate and return
    const populatedConversation = await Conversation.findById(conversation._id)
      .populate("user_id", "email first_name last_name")
      .populate("owner_id", "business_name user_id")
      .populate("booking_id", "booking_number space_id");
    console.log("[createConversation] Conversation populated successfully");

    console.log("[createConversation] SUCCESS: Returning new conversation with status 201");
    return success(
      res,
      { conversation: populatedConversation, existing: false },
      null,
      201
    );
  } catch (err) {
    console.log("[createConversation] ERROR: Exception caught");
    console.log("[createConversation] Error name:", err.name);
    console.log("[createConversation] Error message:", err.message);
    console.log("[createConversation] Error stack:", err.stack);
    return error(
      res,
      errorCodes.SERVER_ERROR,
      500,
      "Error creating conversation"
    );
  }
};

/**
 * @desc    Mark conversation as read
 * @route   PUT /api/conversations/:id/read
 * @access  Private/Participant
 */
exports.markAsRead = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Get conversation
    const conversation = await Conversation.findById(id);

    if (!conversation) {
      return error(res, errorCodes.NOT_FOUND, 404, "Conversation not found");
    }

    // Check authorization - user must be a participant
    const owner = await Owner.findOne({ user_id: req.user._id });
    const isParticipant =
      conversation.user_id.toString() === req.user._id.toString() ||
      (owner && conversation.owner_id.toString() === owner._id.toString());

    if (!isParticipant && req.user.user_type !== "admin") {
      return error(
        res,
        errorCodes.AUTH_FORBIDDEN,
        403,
        "Not authorized to access this conversation"
      );
    }

    // Mark all unread messages in this conversation as read
    // Messages sent by the other party should be marked as read
    let senderTypeToMarkRead;
    if (owner) {
      // Owner is marking messages from User as read
      senderTypeToMarkRead = "User";
    } else {
      // User is marking messages from Owner as read
      senderTypeToMarkRead = "Owner";
    }

    const updateResult = await Message.updateMany(
      {
        conversation_id: id,
        sender_type: senderTypeToMarkRead,
        is_read: false,
      },
      {
        is_read: true,
      }
    );

    return success(res, {
      message: "Messages marked as read",
      marked_count: updateResult.modifiedCount,
    });
  } catch (err) {
    console.error("Mark as read error:", err);
    return error(
      res,
      errorCodes.SERVER_ERROR,
      500,
      "Error marking messages as read"
    );
  }
};

/**
 * @desc    Delete conversation
 * @route   DELETE /api/conversations/:id
 * @access  Private/Participant
 */
exports.deleteConversation = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Get conversation
    const conversation = await Conversation.findById(id);

    if (!conversation) {
      return error(res, errorCodes.NOT_FOUND, 404, "Conversation not found");
    }

    // Check authorization - user must be a participant
    const owner = await Owner.findOne({ user_id: req.user._id });
    const isParticipant =
      conversation.user_id.toString() === req.user._id.toString() ||
      (owner && conversation.owner_id.toString() === owner._id.toString());

    if (!isParticipant && req.user.user_type !== "admin") {
      return error(
        res,
        errorCodes.AUTH_FORBIDDEN,
        403,
        "Not authorized to delete this conversation"
      );
    }

    // Delete all messages in this conversation
    await Message.deleteMany({ conversation_id: id });

    // Delete the conversation
    await Conversation.findByIdAndDelete(id);

    return success(res, { message: "Conversation deleted successfully" });
  } catch (err) {
    console.error("Delete conversation error:", err);
    return error(
      res,
      errorCodes.SERVER_ERROR,
      500,
      "Error deleting conversation"
    );
  }
};

/**
 * @desc    Get unread conversation count
 * @route   GET /api/conversations/unread/count
 * @access  Private
 */
exports.getUnreadCount = async (req, res, next) => {
  try {
    // Check if user is owner to determine which conversations to check
    const owner = await Owner.findOne({ user_id: req.user._id });

    let conversationFilter = {};
    let messageSenderType;

    if (owner) {
      // Owner's conversations - count messages from Users
      conversationFilter.owner_id = owner._id;
      messageSenderType = "User";
    } else {
      // Regular user's conversations - count messages from Owners
      conversationFilter.user_id = req.user._id;
      messageSenderType = "Owner";
    }

    // Get all conversations for this user/owner
    const conversations = await Conversation.find(conversationFilter).select(
      "_id"
    );
    const conversationIds = conversations.map((c) => c._id);

    // Count unread messages across all conversations
    const unreadCount = await Message.countDocuments({
      conversation_id: { $in: conversationIds },
      sender_type: messageSenderType,
      is_read: false,
    });

    // Count conversations with at least one unread message
    const conversationsWithUnread = await Message.aggregate([
      {
        $match: {
          conversation_id: { $in: conversationIds },
          sender_type: messageSenderType,
          is_read: false,
        },
      },
      {
        $group: {
          _id: "$conversation_id",
        },
      },
      {
        $count: "total",
      },
    ]);

    const unreadConversationCount =
      conversationsWithUnread.length > 0 ? conversationsWithUnread[0].total : 0;

    return success(res, {
      unread_message_count: unreadCount,
      unread_conversation_count: unreadConversationCount,
    });
  } catch (err) {
    console.error("Get unread count error:", err);
    return error(
      res,
      errorCodes.SERVER_ERROR,
      500,
      "Error fetching unread count"
    );
  }
};

// /**
//  * Conversations Controller
//  * Handles conversation threads between users and owners
//  */

// const Conversation = require('../models/Conversation');
// const Message = require('../models/Message');
// const Owner = require('../models/Owner');
// const { success, error, paginationMeta } = require('../utils/responseHelper');
// const errorCodes = require('../utils/errorCodes');

// /**
//  * @desc    Get all conversations for a user
//  * @route   GET /api/conversations
//  * @access  Private
//  */
// exports.getUserConversations = async (req, res, next) => {
//   try {
//     const { page = 1, limit = 10 } = req.query;
//     const validPage = Math.max(1, parseInt(page));
//     const validLimit = Math.min(100, Math.max(1, parseInt(limit)));

//     // Check if user is owner to fetch appropriate conversations
//     const owner = await Owner.findOne({ user_id: req.user._id });

//     let filter = {};
//     if (owner) {
//       // If user is an owner, get conversations where they are the owner
//       filter.owner_id = owner._id;
//     } else {
//       // Otherwise, get conversations where they are the regular user
//       filter.user_id = req.user._id;
//     }

//     // Get total count
//     const total = await Conversation.countDocuments(filter);

//     // Get conversations with pagination
//     const conversations = await Conversation.find(filter)
//       .populate('user_id', 'email first_name last_name')
//       .populate('owner_id', 'business_name user_id')
//       .populate('booking_id', 'booking_number space_id')
//       .sort({ last_message_at: -1 })
//       .skip((validPage - 1) * validLimit)
//       .limit(validLimit);

//     // Get unread count for each conversation
//     const conversationsWithUnread = await Promise.all(
//       conversations.map(async (conv) => {
//         const convObj = conv.toObject();

//         // Determine who is the recipient to count unread messages
//         let recipientFilter = {
//           conversation_id: conv._id,
//           is_read: false
//         };

//         if (owner) {
//           // Owner receives messages from users
//           recipientFilter.sender_type = 'User';
//         } else {
//           // User receives messages from owners
//           recipientFilter.sender_type = 'Owner';
//         }

//         const unreadCount = await Message.countDocuments(recipientFilter);
//         convObj.unread_count = unreadCount;

//         return convObj;
//       })
//     );

//     const meta = paginationMeta(validPage, validLimit, total);

//     return success(res, { conversations: conversationsWithUnread }, meta);
//   } catch (err) {
//     console.error('Get user conversations error:', err);
//     return error(res, errorCodes.SERVER_ERROR, 500, 'Error fetching conversations');
//   }
// };

// /**
//  * @desc    Get conversation by ID
//  * @route   GET /api/conversations/:id
//  * @access  Private/Participant
//  */
// exports.getConversationById = async (req, res, next) => {
//   try {
//     const { id } = req.params;

//     // Get conversation
//     const conversation = await Conversation.findById(id)
//       .populate('user_id', 'email first_name last_name')
//       .populate('owner_id', 'business_name user_id')
//       .populate('booking_id', 'booking_number space_id');

//     if (!conversation) {
//       return error(res, errorCodes.NOT_FOUND, 404, 'Conversation not found');
//     }

//     // Check authorization - user must be a participant
//     const owner = await Owner.findOne({ user_id: req.user._id });
//     const isParticipant =
//       conversation.user_id._id.toString() === req.user._id.toString() ||
//       (owner && conversation.owner_id._id.toString() === owner._id.toString());

//     if (!isParticipant && req.user.user_type !== 'admin') {
//       return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to view this conversation');
//     }

//     // Get messages for this conversation
//     const messages = await Message.find({ conversation_id: id })
//       .sort({ created_at: 1 })
//       .limit(50); // Get last 50 messages

//     const conversationObj = conversation.toObject();
//     conversationObj.messages = messages;

//     return success(res, { conversation: conversationObj });
//   } catch (err) {
//     console.error('Get conversation by ID error:', err);
//     return error(res, errorCodes.SERVER_ERROR, 500, 'Error fetching conversation');
//   }
// };

// /**
//  * @desc    Create or get conversation
//  * @route   POST /api/conversations
//  * @access  Private
//  */
// exports.createConversation = async (req, res, next) => {
//   try {
//     const { participant_id, booking_id } = req.body;

//     // participant_id is the owner_id
//     const owner_id = participant_id;

//     // Verify owner exists
//     const owner = await Owner.findById(owner_id);
//     if (!owner) {
//       return error(res, errorCodes.NOT_FOUND, 404, 'Owner not found');
//     }

//     // Check if conversation already exists between user and owner
//     let conversation = await Conversation.findOne({
//       user_id: req.user._id,
//       owner_id: owner_id
//     })
//       .populate('user_id', 'email first_name last_name')
//       .populate('owner_id', 'business_name user_id')
//       .populate('booking_id', 'booking_number space_id');

//     if (conversation) {
//       // Return existing conversation
//       return success(res, { conversation, existing: true });
//     }

//     // Validate booking if provided
//     if (booking_id) {
//       const Booking = require('../models/Booking');
//       const booking = await Booking.findById(booking_id);

//       if (!booking) {
//         return error(res, errorCodes.NOT_FOUND, 404, 'Booking not found');
//       }

//       // Verify booking belongs to user
//       if (booking.user_id.toString() !== req.user._id.toString()) {
//         return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Booking does not belong to you');
//       }

//       // Verify booking is with this owner
//       if (booking.owner_id.toString() !== owner_id) {
//         return error(res, errorCodes.BIZ_VALIDATION, 400, 'Booking is not with this owner');
//       }
//     }

//     // Create new conversation
//     conversation = await Conversation.create({
//       user_id: req.user._id,
//       owner_id: owner_id,
//       booking_id: booking_id || null,
//       last_message_at: new Date()
//     });

//     // Populate and return
//     const populatedConversation = await Conversation.findById(conversation._id)
//       .populate('user_id', 'email first_name last_name')
//       .populate('owner_id', 'business_name user_id')
//       .populate('booking_id', 'booking_number space_id');

//     return success(res, { conversation: populatedConversation, existing: false }, null, 201);
//   } catch (err) {
//     console.error('Create conversation error:', err);
//     return error(res, errorCodes.SERVER_ERROR, 500, 'Error creating conversation');
//   }
// };

// /**
//  * @desc    Mark conversation as read
//  * @route   PUT /api/conversations/:id/read
//  * @access  Private/Participant
//  */
// exports.markAsRead = async (req, res, next) => {
//   try {
//     const { id } = req.params;

//     // Get conversation
//     const conversation = await Conversation.findById(id);

//     if (!conversation) {
//       return error(res, errorCodes.NOT_FOUND, 404, 'Conversation not found');
//     }

//     // Check authorization - user must be a participant
//     const owner = await Owner.findOne({ user_id: req.user._id });
//     const isParticipant =
//       conversation.user_id.toString() === req.user._id.toString() ||
//       (owner && conversation.owner_id.toString() === owner._id.toString());

//     if (!isParticipant && req.user.user_type !== 'admin') {
//       return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to access this conversation');
//     }

//     // Mark all unread messages in this conversation as read
//     // Messages sent by the other party should be marked as read
//     let senderTypeToMarkRead;
//     if (owner) {
//       // Owner is marking messages from User as read
//       senderTypeToMarkRead = 'User';
//     } else {
//       // User is marking messages from Owner as read
//       senderTypeToMarkRead = 'Owner';
//     }

//     const updateResult = await Message.updateMany(
//       {
//         conversation_id: id,
//         sender_type: senderTypeToMarkRead,
//         is_read: false
//       },
//       {
//         is_read: true
//       }
//     );

//     return success(res, {
//       message: 'Messages marked as read',
//       marked_count: updateResult.modifiedCount
//     });
//   } catch (err) {
//     console.error('Mark as read error:', err);
//     return error(res, errorCodes.SERVER_ERROR, 500, 'Error marking messages as read');
//   }
// };

// /**
//  * @desc    Delete conversation
//  * @route   DELETE /api/conversations/:id
//  * @access  Private/Participant
//  */
// exports.deleteConversation = async (req, res, next) => {
//   try {
//     const { id } = req.params;

//     // Get conversation
//     const conversation = await Conversation.findById(id);

//     if (!conversation) {
//       return error(res, errorCodes.NOT_FOUND, 404, 'Conversation not found');
//     }

//     // Check authorization - user must be a participant
//     const owner = await Owner.findOne({ user_id: req.user._id });
//     const isParticipant =
//       conversation.user_id.toString() === req.user._id.toString() ||
//       (owner && conversation.owner_id.toString() === owner._id.toString());

//     if (!isParticipant && req.user.user_type !== 'admin') {
//       return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to delete this conversation');
//     }

//     // Delete all messages in this conversation
//     await Message.deleteMany({ conversation_id: id });

//     // Delete the conversation
//     await Conversation.findByIdAndDelete(id);

//     return success(res, { message: 'Conversation deleted successfully' });
//   } catch (err) {
//     console.error('Delete conversation error:', err);
//     return error(res, errorCodes.SERVER_ERROR, 500, 'Error deleting conversation');
//   }
// };

// /**
//  * @desc    Get unread conversation count
//  * @route   GET /api/conversations/unread/count
//  * @access  Private
//  */
// exports.getUnreadCount = async (req, res, next) => {
//   try {
//     // Check if user is owner to determine which conversations to check
//     const owner = await Owner.findOne({ user_id: req.user._id });

//     let conversationFilter = {};
//     let messageSenderType;

//     if (owner) {
//       // Owner's conversations - count messages from Users
//       conversationFilter.owner_id = owner._id;
//       messageSenderType = 'User';
//     } else {
//       // Regular user's conversations - count messages from Owners
//       conversationFilter.user_id = req.user._id;
//       messageSenderType = 'Owner';
//     }

//     // Get all conversations for this user/owner
//     const conversations = await Conversation.find(conversationFilter).select('_id');
//     const conversationIds = conversations.map(c => c._id);

//     // Count unread messages across all conversations
//     const unreadCount = await Message.countDocuments({
//       conversation_id: { $in: conversationIds },
//       sender_type: messageSenderType,
//       is_read: false
//     });

//     // Count conversations with at least one unread message
//     const conversationsWithUnread = await Message.aggregate([
//       {
//         $match: {
//           conversation_id: { $in: conversationIds },
//           sender_type: messageSenderType,
//           is_read: false
//         }
//       },
//       {
//         $group: {
//           _id: '$conversation_id'
//         }
//       },
//       {
//         $count: 'total'
//       }
//     ]);

//     const unreadConversationCount = conversationsWithUnread.length > 0 ? conversationsWithUnread[0].total : 0;

//     return success(res, {
//       unread_message_count: unreadCount,
//       unread_conversation_count: unreadConversationCount
//     });
//   } catch (err) {
//     console.error('Get unread count error:', err);
//     return error(res, errorCodes.SERVER_ERROR, 500, 'Error fetching unread count');
//   }
// };
