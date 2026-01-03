/**
 * Authentication Controller
 * Handles user registration, login, password management, and session control
 */

const User = require('../models/User');
const Owner = require('../models/Owner');
const Admin = require('../models/Admin');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const generateToken = require('../utils/generateToken');
const { success, error } = require('../utils/responseHelper');
const errorCodes = require('../utils/errorCodes');

/**
 * @desc    Register new user
 * @route   POST /api/auth/register
 * @access  Public
 */
exports.register = async (req, res, next) => {
  try {
    const { email, phone, password, first_name, last_name, user_type } = req.body;

    // Check if user already exists with email
    const existingUserByEmail = await User.findOne({ email: email.toLowerCase() });
    if (existingUserByEmail) {
      return error(res, errorCodes.REQ_DUPLICATE, 409, 'Email already registered', {
        field: 'email'
      });
    }

    // Check if user already exists with phone
    const existingUserByPhone = await User.findOne({ phone });
    if (existingUserByPhone) {
      return error(res, errorCodes.REQ_DUPLICATE, 409, 'Phone number already registered', {
        field: 'phone'
      });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    // Generate email verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Create user
    const user = await User.create({
      email: email.toLowerCase(),
      phone,
      password_hash,
      first_name,
      last_name,
      user_type: user_type || 'user',
      verification_token: verificationToken,
      verification_token_expiry: verificationTokenExpiry,
      is_verified: false,
      is_active: true
    });

    // Generate JWT token
    const token = generateToken(user._id);

    // TODO: Send verification email with verificationToken
    // For now, we'll just log it
    console.log(`Verification token for ${email}: ${verificationToken}`);

    // Return user without password
    const userResponse = {
      _id: user._id,
      email: user.email,
      phone: user.phone,
      first_name: user.first_name,
      last_name: user.last_name,
      user_type: user.user_type,
      is_verified: user.is_verified,
      created_at: user.created_at
    };

    return success(res, { user: userResponse, token }, null, 201);
  } catch (err) {
    console.error('Registration error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error registering user');
  }
};

/**
 * @desc    Login user
 * @route   POST /api/auth/login
 * @access  Public
 */
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Find user by email and include password
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password_hash');

    if (!user) {
      return error(res, errorCodes.AUTH_INVALID_CREDENTIALS, 401, 'Invalid email or password');
    }

    // Check if user is active
    if (!user.is_active) {
      return error(res, errorCodes.AUTH_ACCOUNT_LOCKED, 403, 'Account is inactive. Please contact support.');
    }

    // Verify password
    const isPasswordMatch = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordMatch) {
      return error(res, errorCodes.AUTH_INVALID_CREDENTIALS, 401, 'Invalid email or password');
    }

    // Generate JWT token
    const token = generateToken(user._id);

    // Update last login
    user.last_login = new Date();
    await user.save();

    // Fetch owner_id or admin_id based on user_type
    let owner_id = null;
    let admin_id = null;

    if (user.user_type === 'owner') {
      const ownerRecord = await Owner.findOne({ user_id: user._id });
      if (ownerRecord && ownerRecord._id) {
        owner_id = ownerRecord._id;
      }
    } else if (user.user_type === 'admin') {
      const adminRecord = await Admin.findOne({ user_id: user._id });
      if (adminRecord && adminRecord._id) {
        admin_id = adminRecord._id;
      }
    }

    // Return user without password
    const userResponse = {
      _id: user._id,
      email: user.email,
      phone: user.phone,
      first_name: user.first_name,
      last_name: user.last_name,
      user_type: user.user_type,
      is_verified: user.is_verified,
      location_lat: user.location_lat,
      location_lng: user.location_lng,
      created_at: user.created_at
    };

    // Include owner_id or admin_id if available
    if (owner_id) {
      userResponse.owner_id = owner_id;
    }
    if (admin_id) {
      userResponse.admin_id = admin_id;
    }

    return success(res, { user: userResponse, token });
  } catch (err) {
    console.error('Login error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error logging in');
  }
};

/**
 * @desc    Logout user
 * @route   POST /api/auth/logout
 * @access  Private
 */
exports.logout = async (req, res, next) => {
  try {
    // With Bearer tokens, logout is handled client-side by removing the token
    // Server-side logout would require token blacklisting (Redis/database)
    return success(res, { message: 'Logged out successfully. Please remove the token from client.' });
  } catch (err) {
    console.error('Logout error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error logging out');
  }
};

/**
 * @desc    Get current logged in user
 * @route   GET /api/auth/me
 * @access  Private
 */
exports.getMe = async (req, res, next) => {
  try {
    // req.user is set by the protect middleware
    const user = await User.findById(req.user._id);

    if (!user) {
      return error(res, errorCodes.USER_NOT_FOUND, 404, 'User not found');
    }

    const userResponse = {
      _id: user._id,
      email: user.email,
      phone: user.phone,
      first_name: user.first_name,
      last_name: user.last_name,
      user_type: user.user_type,
      is_verified: user.is_verified,
      location_lat: user.location_lat,
      location_lng: user.location_lng,
      created_at: user.created_at,
      updated_at: user.updated_at
    };

    return success(res, { user: userResponse });
  } catch (err) {
    console.error('Get me error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error fetching user');
  }
};

/**
 * @desc    Verify email with token
 * @route   GET /api/auth/verify/:token
 * @access  Public
 */
exports.verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.params;

    // Find user with verification token that hasn't expired
    const user = await User.findOne({
      verification_token: token,
      verification_token_expiry: { $gt: Date.now() }
    });

    if (!user) {
      return error(res, errorCodes.REQ_VALIDATION, 400, 'Invalid or expired verification token');
    }

    // Mark user as verified
    user.is_verified = true;
    user.verification_token = undefined;
    user.verification_token_expiry = undefined;
    await user.save();

    return success(res, {
      message: 'Email verified successfully',
      email: user.email
    });
  } catch (err) {
    console.error('Email verification error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error verifying email');
  }
};

/**
 * @desc    Resend verification email
 * @route   POST /api/auth/resend-verification
 * @access  Private
 */
exports.resendVerification = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return error(res, errorCodes.USER_NOT_FOUND, 404, 'User not found');
    }

    // Check if already verified
    if (user.is_verified) {
      return error(res, errorCodes.REQ_VALIDATION, 400, 'Email already verified');
    }

    // Generate new verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    user.verification_token = verificationToken;
    user.verification_token_expiry = verificationTokenExpiry;
    await user.save();

    // TODO: Send verification email with verificationToken
    console.log(`New verification token for ${user.email}: ${verificationToken}`);

    return success(res, {
      message: 'Verification email sent successfully',
      email: user.email
    });
  } catch (err) {
    console.error('Resend verification error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error resending verification email');
  }
};

/**
 * @desc    Request password reset
 * @route   POST /api/auth/forgot-password
 * @access  Public
 */
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      // For security, don't reveal if email exists
      return success(res, {
        message: 'If the email exists, a password reset link has been sent'
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Hash token before saving to database
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

    user.reset_password_token = resetTokenHash;
    user.reset_password_expiry = resetTokenExpiry;
    await user.save();

    // TODO: Send password reset email with resetToken
    console.log(`Password reset token for ${email}: ${resetToken}`);

    return success(res, {
      message: 'If the email exists, a password reset link has been sent'
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error processing password reset request');
  }
};

/**
 * @desc    Reset password with token
 * @route   PUT /api/auth/reset-password/:token
 * @access  Public
 */
exports.resetPassword = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    // Hash the token from URL to compare with database
    const resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Find user with reset token that hasn't expired
    const user = await User.findOne({
      reset_password_token: resetTokenHash,
      reset_password_expiry: { $gt: Date.now() }
    });

    if (!user) {
      return error(res, errorCodes.REQ_VALIDATION, 400, 'Invalid or expired reset token');
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    user.password_hash = await bcrypt.hash(password, salt);

    // Clear reset token fields
    user.reset_password_token = undefined;
    user.reset_password_expiry = undefined;
    await user.save();

    return success(res, {
      message: 'Password reset successfully'
    });
  } catch (err) {
    console.error('Reset password error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error resetting password');
  }
};

/**
 * @desc    Change password (logged in user)
 * @route   PUT /api/auth/change-password
 * @access  Private
 */
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // Get user with password
    const user = await User.findById(req.user._id).select('+password_hash');

    if (!user) {
      return error(res, errorCodes.USER_NOT_FOUND, 404, 'User not found');
    }

    // Verify current password
    const isPasswordMatch = await bcrypt.compare(currentPassword, user.password_hash);

    if (!isPasswordMatch) {
      return error(res, errorCodes.AUTH_INVALID_CREDENTIALS, 401, 'Current password is incorrect');
    }

    // Check if new password is same as old password
    const isSamePassword = await bcrypt.compare(newPassword, user.password_hash);
    if (isSamePassword) {
      return error(res, errorCodes.REQ_VALIDATION, 400, 'New password must be different from current password');
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    user.password_hash = await bcrypt.hash(newPassword, salt);
    await user.save();

    return success(res, {
      message: 'Password changed successfully'
    });
  } catch (err) {
    console.error('Change password error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error changing password');
  }
};

/**
 * @desc    Refresh access token
 * @route   POST /api/auth/refresh-token
 * @access  Public
 */
exports.refreshToken = async (req, res, next) => {
  try {
    let token;

    // Get token from Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return error(res, errorCodes.AUTH_UNAUTHORIZED, 401, 'No token provided');
    }

    // Verify token (allow expired tokens for refresh)
    const jwt = require('jsonwebtoken');
    let decoded;

    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      // If token is expired, we can still decode it
      if (err.name === 'TokenExpiredError') {
        decoded = jwt.decode(token);
      } else {
        return error(res, errorCodes.AUTH_INVALID_TOKEN, 401, 'Invalid token');
      }
    }

    // Get user
    const user = await User.findById(decoded.id);

    if (!user || !user.is_active) {
      return error(res, errorCodes.USER_NOT_FOUND, 404, 'User not found or inactive');
    }

    // Generate new token
    const newToken = generateToken(user._id);

    return success(res, {
      token: newToken,
      message: 'Token refreshed successfully'
    });
  } catch (err) {
    console.error('Refresh token error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error refreshing token');
  }
};
