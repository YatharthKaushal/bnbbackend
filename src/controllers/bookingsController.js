/**
 * Bookings Controller
 * Handles booking lifecycle, conflict detection, and check-in/out
 */

const Booking = require('../models/Booking');
const ParkingSpace = require('../models/ParkingSpace');
const UserVehicle = require('../models/UserVehicle');
const { success, error } = require('../utils/responseHelper');
const errorCodes = require('../utils/errorCodes');

/**
 * Helper function to generate unique booking number
 */
const generateBookingNumber = () => {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `BK-${timestamp}-${random}`;
};

/**
 * Helper function to check booking conflicts
 */
const hasBookingConflict = async (spaceId, startTime, endTime, excludeBookingId = null) => {
  const filter = {
    space_id: spaceId,
    status: { $nin: ['cancelled', 'completed', 'no_show'] },
    $or: [
      { start_time: { $lte: startTime }, end_time: { $gt: startTime } },
      { start_time: { $lt: endTime }, end_time: { $gte: endTime } },
      { start_time: { $gte: startTime }, end_time: { $lte: endTime } }
    ]
  };

  if (excludeBookingId) {
    filter._id = { $ne: excludeBookingId };
  }

  const conflictingBooking = await Booking.findOne(filter);
  return conflictingBooking;
};

/**
 * Helper function to calculate booking price
 */
const calculateBookingPrice = (parkingSpace, durationHours) => {
  let basePrice = 0;

  if (durationHours <= 24) {
    basePrice = parkingSpace.hourly_rate * durationHours;
  } else if (durationHours <= 24 * 30) {
    const days = Math.ceil(durationHours / 24);
    basePrice = parkingSpace.daily_rate * days;
  } else {
    const months = Math.ceil(durationHours / (24 * 30));
    basePrice = parkingSpace.monthly_rate * months;
  }

  return basePrice;
};

/**
 * Helper function to validate pagination
 */
const validatePagination = (page, limit) => {
  const validPage = Math.max(1, parseInt(page) || 1);
  const validLimit = Math.min(100, Math.max(1, parseInt(limit) || 10));
  return { page: validPage, limit: validLimit };
};

/**
 * @desc    Get all bookings
 * @route   GET /api/bookings
 * @access  Private/Admin
 */
exports.getAllBookings = async (req, res, next) => {
  try {
    const { page = 1, limit = 10, status, payment_status, user_id, owner_id, space_id } = req.query;
    const { page: validPage, limit: validLimit } = validatePagination(page, limit);

    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (payment_status) filter.payment_status = payment_status;
    if (user_id) filter.user_id = user_id;
    if (owner_id) filter.owner_id = owner_id;
    if (space_id) filter.space_id = space_id;

    // Get total count
    const total = await Booking.countDocuments(filter);

    // Get bookings
    const bookings = await Booking.find(filter)
      .populate('user_id', 'email first_name last_name phone')
      .populate('space_id', 'space_number space_type hourly_rate')
      .populate('vehicle_id', 'vehicle_make vehicle_model license_plate')
      .sort({ created_at: -1 })
      .skip((validPage - 1) * validLimit)
      .limit(validLimit);

    return success(res, bookings, {
      page: validPage,
      limit: validLimit,
      total,
      totalPages: Math.ceil(total / validLimit)
    });
  } catch (err) {
    console.error('Get all bookings error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error fetching bookings');
  }
};

/**
 * @desc    Get booking by ID
 * @route   GET /api/bookings/:id
 * @access  Private/Owner or Admin
 */
exports.getBookingById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const booking = await Booking.findById(id)
      .populate('user_id', 'email first_name last_name phone')
      .populate('owner_id', 'user_id business_name')
      .populate('space_id', 'space_number space_type property_id hourly_rate daily_rate')
      .populate('vehicle_id', 'vehicle_make vehicle_model vehicle_year license_plate');

    if (!booking) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Booking not found');
    }

    // Check authorization
    const ownerUserId = booking.owner_id && booking.owner_id.user_id ? booking.owner_id.user_id.toString() : null;
    if (req.user.user_type !== 'admin' &&
        booking.user_id._id.toString() !== req.user._id.toString() &&
        ownerUserId !== req.user._id.toString()) {
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to view this booking');
    }

    return success(res, { booking });
  } catch (err) {
    console.error('Get booking by ID error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error fetching booking');
  }
};

/**
 * @desc    Get user's bookings
 * @route   GET /api/bookings/users/:userId/bookings
 * @access  Private
 */
exports.getUserBookings = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 10, status } = req.query;
    const { page: validPage, limit: validLimit } = validatePagination(page, limit);

    // Check authorization
    if (req.user.user_type !== 'admin' && userId !== req.user._id.toString()) {
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to view these bookings');
    }

    // Build filter
    const filter = { user_id: userId };
    if (status) filter.status = status;

    // Get total count
    const total = await Booking.countDocuments(filter);

    // Get bookings
    const bookings = await Booking.find(filter)
      .populate('space_id', 'space_number space_type hourly_rate property_id')
      .populate('vehicle_id', 'vehicle_make vehicle_model license_plate')
      .sort({ created_at: -1 })
      .skip((validPage - 1) * validLimit)
      .limit(validLimit);

    return success(res, bookings, {
      page: validPage,
      limit: validLimit,
      total,
      totalPages: Math.ceil(total / validLimit)
    });
  } catch (err) {
    console.error('Get user bookings error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error fetching user bookings');
  }
};

/**
 * @desc    Get owner's bookings
 * @route   GET /api/bookings/owners/:ownerId/bookings
 * @access  Private
 */
exports.getOwnerBookings = async (req, res, next) => {
  try {
    const { ownerId } = req.params;
    const { page = 1, limit = 10, status } = req.query;
    const { page: validPage, limit: validLimit } = validatePagination(page, limit);

    // Build filter
    const filter = { owner_id: ownerId };
    if (status) filter.status = status;

    // Get total count
    const total = await Booking.countDocuments(filter);

    // Get bookings
    const bookings = await Booking.find(filter)
      .populate('user_id', 'email first_name last_name phone')
      .populate('space_id', 'space_number space_type')
      .populate('vehicle_id', 'vehicle_make vehicle_model license_plate')
      .sort({ created_at: -1 })
      .skip((validPage - 1) * validLimit)
      .limit(validLimit);

    return success(res, bookings, {
      page: validPage,
      limit: validLimit,
      total,
      totalPages: Math.ceil(total / validLimit)
    });
  } catch (err) {
    console.error('Get owner bookings error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error fetching owner bookings');
  }
};

/**
 * @desc    Create new booking
 * @route   POST /api/bookings
 * @access  Private
 */
exports.createBooking = async (req, res, next) => {
  try {
    const { space_id, vehicle_id, start_time, end_time, promo_code } = req.body;

    // Validate required fields
    if (!space_id || !vehicle_id || !start_time || !end_time) {
      return error(res, errorCodes.REQ_VALIDATION, 400, 'Missing required fields');
    }

    // Validate dates
    const startDate = new Date(start_time);
    const endDate = new Date(end_time);
    const now = new Date();

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return error(res, errorCodes.REQ_VALIDATION, 400, 'Invalid date format');
    }

    if (startDate < now) {
      return error(res, errorCodes.BIZ_VALIDATION, 400, 'Start time cannot be in the past');
    }

    if (endDate <= startDate) {
      return error(res, errorCodes.BIZ_VALIDATION, 400, 'End time must be after start time');
    }

    // Check if parking space exists and is active
    const parkingSpace = await ParkingSpace.findById(space_id)
      .populate('owner_id', 'user_id business_name');

    if (!parkingSpace) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Parking space not found');
    }

    if (parkingSpace.status !== 'active') {
      return error(res, errorCodes.BIZ_UNAVAILABLE, 400, 'Parking space is not available');
    }

    // Check if vehicle exists and belongs to the user
    const vehicle = await UserVehicle.findById(vehicle_id);

    if (!vehicle) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Vehicle not found');
    }

    if (vehicle.user_id.toString() !== req.user._id.toString()) {
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Vehicle does not belong to you');
    }

    if (!vehicle.is_verified) {
      return error(res, errorCodes.BIZ_VALIDATION, 400, 'Vehicle must be verified before booking');
    }

    // Check for booking conflicts
    const conflict = await hasBookingConflict(space_id, startDate, endDate);
    if (conflict) {
      return error(res, errorCodes.BIZ_CONFLICT, 409, 'Parking space is already booked for this time period');
    }

    // Calculate duration and price
    const durationMs = endDate - startDate;
    const durationHours = durationMs / (1000 * 60 * 60);
    let totalPrice = calculateBookingPrice(parkingSpace, durationHours);
    let discountAmount = 0;
    let finalPrice = totalPrice;

    // Apply promo code if provided
    if (promo_code) {
      const PromoCode = require('../models/PromoCode');
      const promo = await PromoCode.findOne({
        code: promo_code,
        is_active: true,
        valid_from: { $lte: now },
        valid_to: { $gte: now }
      });

      if (promo) {
        // Check usage limits
        if (promo.max_uses && promo.used_count >= promo.max_uses) {
          return error(res, errorCodes.BIZ_VALIDATION, 400, 'Promo code has reached maximum usage limit');
        }

        // Check minimum booking amount
        if (promo.min_booking_amount && totalPrice < promo.min_booking_amount) {
          return error(res, errorCodes.BIZ_VALIDATION, 400, `Minimum booking amount of ${promo.min_booking_amount} required for this promo code`);
        }

        // Calculate discount
        if (promo.discount_type === 'percentage') {
          discountAmount = (totalPrice * promo.discount_value) / 100;
          if (promo.max_discount_amount) {
            discountAmount = Math.min(discountAmount, promo.max_discount_amount);
          }
        } else if (promo.discount_type === 'fixed') {
          discountAmount = promo.discount_value;
        }

        finalPrice = Math.max(0, totalPrice - discountAmount);

        // Increment promo code usage
        promo.used_count += 1;
        await promo.save();
      } else {
        return error(res, errorCodes.BIZ_VALIDATION, 400, 'Invalid or expired promo code');
      }
    }

    // Generate booking number
    const bookingNumber = generateBookingNumber();

    // Create booking
    const booking = await Booking.create({
      booking_number: bookingNumber,
      user_id: req.user._id,
      owner_id: parkingSpace.owner_id._id,
      space_id: space_id,
      vehicle_id: vehicle_id,
      start_time: startDate,
      end_time: endDate,
      duration_hours: durationHours,
      base_price: totalPrice,
      discount_amount: discountAmount,
      total_amount: finalPrice,
      status: 'confirmed',
      payment_status: 'confirmed',
      promo_code: promo_code || null
    });

    // Populate booking details
    const populatedBooking = await Booking.findById(booking._id)
      .populate('user_id', 'email first_name last_name phone')
      .populate('owner_id', 'business_name')
      .populate('space_id', 'space_number space_type hourly_rate daily_rate monthly_rate')
      .populate('vehicle_id', 'vehicle_make vehicle_model license_plate');

    return success(res, { booking: populatedBooking }, null, 201);
  } catch (err) {
    console.error('Create booking error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error creating booking');
  }
};

/**
 * @desc    Update booking
 * @route   PUT /api/bookings/:id
 * @access  Private/Owner
 */
exports.updateBooking = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { start_time, end_time, vehicle_id } = req.body;

    // Find booking
    const booking = await Booking.findById(id).populate('space_id');

    if (!booking) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Booking not found');
    }

    // Check authorization
    if (booking.user_id.toString() !== req.user._id.toString() && req.user.user_type !== 'admin') {
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to update this booking');
    }

    // Only allow updates for pending or confirmed bookings
    if (!['pending', 'confirmed'].includes(booking.status)) {
      return error(res, errorCodes.BIZ_OPERATION_NOT_ALLOWED, 400, 'Cannot update booking in current status');
    }

    // Update vehicle if provided
    if (vehicle_id && vehicle_id !== booking.vehicle_id.toString()) {
      const vehicle = await UserVehicle.findById(vehicle_id);

      if (!vehicle) {
        return error(res, errorCodes.NOT_FOUND, 404, 'Vehicle not found');
      }

      if (vehicle.user_id.toString() !== req.user._id.toString()) {
        return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Vehicle does not belong to you');
      }

      if (!vehicle.is_verified) {
        return error(res, errorCodes.BIZ_VALIDATION, 400, 'Vehicle must be verified');
      }

      booking.vehicle_id = vehicle_id;
    }

    // Update dates if provided
    if (start_time || end_time) {
      const newStartTime = start_time ? new Date(start_time) : booking.start_time;
      const newEndTime = end_time ? new Date(end_time) : booking.end_time;
      const now = new Date();

      // Validate dates
      if (isNaN(newStartTime.getTime()) || isNaN(newEndTime.getTime())) {
        return error(res, errorCodes.REQ_VALIDATION, 400, 'Invalid date format');
      }

      if (newStartTime < now) {
        return error(res, errorCodes.BIZ_VALIDATION, 400, 'Start time cannot be in the past');
      }

      if (newEndTime <= newStartTime) {
        return error(res, errorCodes.BIZ_VALIDATION, 400, 'End time must be after start time');
      }

      // Check for conflicts with the new dates
      const conflict = await hasBookingConflict(booking.space_id._id, newStartTime, newEndTime, booking._id);
      if (conflict) {
        return error(res, errorCodes.BIZ_CONFLICT, 409, 'Parking space is already booked for this time period');
      }

      // Recalculate price if dates changed
      const durationMs = newEndTime - newStartTime;
      const durationHours = durationMs / (1000 * 60 * 60);
      const newTotalPrice = calculateBookingPrice(booking.space_id, durationHours);

      booking.start_time = newStartTime;
      booking.end_time = newEndTime;
      booking.total_price = newTotalPrice;
      booking.final_price = newTotalPrice - booking.discount_amount;
    }

    await booking.save();

    // Populate and return updated booking
    const updatedBooking = await Booking.findById(id)
      .populate('user_id', 'email first_name last_name phone')
      .populate('owner_id', 'business_name')
      .populate('space_id', 'space_number space_type hourly_rate daily_rate monthly_rate')
      .populate('vehicle_id', 'vehicle_make vehicle_model license_plate');

    return success(res, { booking: updatedBooking });
  } catch (err) {
    console.error('Update booking error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error updating booking');
  }
};

/**
 * @desc    Cancel booking
 * @route   PUT /api/bookings/:id/cancel
 * @access  Private/Owner or Admin
 */
exports.cancelBooking = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { cancellation_reason } = req.body;

    // Find booking
    const booking = await Booking.findById(id).populate('space_id');

    if (!booking) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Booking not found');
    }

    // Check authorization
    const ownerUserId = booking.owner_id ? booking.owner_id.toString() : null;
    if (booking.user_id.toString() !== req.user._id.toString() &&
        req.user.user_type !== 'admin' &&
        ownerUserId !== req.user._id.toString()) {
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to cancel this booking');
    }

    // Cannot cancel already cancelled, completed, or no-show bookings
    if (['cancelled', 'completed', 'no_show'].includes(booking.status)) {
      return error(res, errorCodes.BIZ_OPERATION_NOT_ALLOWED, 400, 'Cannot cancel booking in current status');
    }

    // Check if booking has already started
    const now = new Date();
    const hasStarted = now >= booking.start_time;

    // Calculate refund amount based on cancellation policy
    let refundAmount = 0;
    let refundPercentage = 0;

    if (!hasStarted) {
      const hoursUntilStart = (booking.start_time - now) / (1000 * 60 * 60);

      // Refund policy:
      // > 48 hours: 100% refund
      // 24-48 hours: 50% refund
      // < 24 hours: 0% refund
      if (hoursUntilStart > 48) {
        refundPercentage = 100;
      } else if (hoursUntilStart > 24) {
        refundPercentage = 50;
      } else {
        refundPercentage = 0;
      }

      refundAmount = (booking.final_price * refundPercentage) / 100;
    }

    // Update booking status
    booking.status = 'cancelled';
    booking.cancellation_reason = cancellation_reason || 'User cancelled';
    booking.cancelled_at = now;
    booking.refund_amount = refundAmount;

    // If payment was completed, create refund record
    if (booking.payment_status === 'completed' && refundAmount > 0) {
      const Refund = require('../models/Refund');
      await Refund.create({
        booking_id: booking._id,
        user_id: booking.user_id,
        amount: refundAmount,
        reason: cancellation_reason || 'Booking cancelled',
        status: 'pending',
        initiated_by: req.user._id
      });
    }

    await booking.save();

    // Populate and return cancelled booking
    const cancelledBooking = await Booking.findById(id)
      .populate('user_id', 'email first_name last_name phone')
      .populate('owner_id', 'business_name')
      .populate('space_id', 'space_number space_type')
      .populate('vehicle_id', 'vehicle_make vehicle_model license_plate');

    return success(res, {
      booking: cancelledBooking,
      refund: {
        amount: refundAmount,
        percentage: refundPercentage,
        status: refundAmount > 0 ? 'pending' : 'not_applicable'
      }
    });
  } catch (err) {
    console.error('Cancel booking error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error cancelling booking');
  }
};

/**
 * @desc    Check-in to booking
 * @route   PUT /api/bookings/:id/checkin
 * @access  Private/Owner
 */
exports.checkIn = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { verification_code } = req.body || {};

    // Find booking and populate owner to get user_id
    const booking = await Booking.findById(id).populate('owner_id', 'user_id');

    if (!booking) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Booking not found');
    }

    // Check authorization - only owner or admin can check in
    const ownerUserId = booking.owner_id && booking.owner_id.user_id ? booking.owner_id.user_id.toString() : null;
    if (req.user.user_type !== 'admin' && ownerUserId !== req.user._id.toString()) {
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to check in this booking');
    }

    // Check booking status
    if (booking.status !== 'confirmed') {
      return error(res, errorCodes.BIZ_OPERATION_NOT_ALLOWED, 400, 'Only confirmed bookings can be checked in');
    }

    // Verify check-in is within allowed window (1 hour before to 1 hour after start time)
    const now = new Date();
    const earlyCheckIn = new Date(booking.start_time.getTime() - (60 * 60 * 1000)); // 1 hour before
    const lateCheckIn = new Date(booking.start_time.getTime() + (60 * 60 * 1000)); // 1 hour after

    if (now < earlyCheckIn) {
      return error(res, errorCodes.BIZ_OPERATION_NOT_ALLOWED, 400, 'Check-in window has not opened yet');
    }

    if (now > lateCheckIn) {
      // Mark as no-show if check-in window has passed
      booking.status = 'no_show';
      await booking.save();
      return error(res, errorCodes.BIZ_OPERATION_NOT_ALLOWED, 400, 'Check-in window has passed. Booking marked as no-show');
    }

    // Verify check-in code if provided (optional verification)
    if (verification_code && booking.verification_code && verification_code !== booking.verification_code) {
      return error(res, errorCodes.BIZ_VALIDATION, 400, 'Invalid verification code');
    }

    // Update booking status to active
    booking.status = 'active';
    booking.actual_start_time = now;
    await booking.save();

    // Populate and return booking
    const checkedInBooking = await Booking.findById(id)
      .populate('user_id', 'email first_name last_name phone')
      .populate('owner_id', 'business_name')
      .populate('space_id', 'space_number space_type')
      .populate('vehicle_id', 'vehicle_make vehicle_model license_plate');

    return success(res, { booking: checkedInBooking });
  } catch (err) {
    console.error('Check-in error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error checking in booking');
  }
};

/**
 * @desc    Check-out from booking
 * @route   PUT /api/bookings/:id/checkout
 * @access  Private/Owner
 */
exports.checkOut = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Find booking and populate owner to get user_id
    const booking = await Booking.findById(id).populate('owner_id', 'user_id');

    if (!booking) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Booking not found');
    }

    // Check authorization - only owner or admin can check out
    const ownerUserId = booking.owner_id && booking.owner_id.user_id ? booking.owner_id.user_id.toString() : null;
    if (req.user.user_type !== 'admin' && ownerUserId !== req.user._id.toString()) {
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to check out this booking');
    }

    // Check booking status
    if (booking.status !== 'active') {
      return error(res, errorCodes.BIZ_OPERATION_NOT_ALLOWED, 400, 'Only active bookings can be checked out');
    }

    const now = new Date();

    // Calculate any overtime charges
    let overtimeCharge = 0;
    if (now > booking.end_time) {
      const overtimeMs = now - booking.end_time;
      const overtimeHours = Math.ceil(overtimeMs / (1000 * 60 * 60));

      // Get parking space for hourly rate
      const parkingSpace = await ParkingSpace.findById(booking.space_id);
      if (parkingSpace) {
        overtimeCharge = overtimeHours * parkingSpace.hourly_rate * 1.5; // 1.5x rate for overtime
      }
    }

    // Update booking status to completed
    booking.status = 'completed';
    booking.actual_end_time = now;

    if (overtimeCharge > 0) {
      booking.overtime_charge = overtimeCharge;
      booking.final_price += overtimeCharge;
    }

    await booking.save();

    // Populate and return booking
    const checkedOutBooking = await Booking.findById(id)
      .populate('user_id', 'email first_name last_name phone')
      .populate('owner_id', 'business_name')
      .populate('space_id', 'space_number space_type hourly_rate')
      .populate('vehicle_id', 'vehicle_make vehicle_model license_plate');

    return success(res, {
      booking: checkedOutBooking,
      overtime: overtimeCharge > 0 ? {
        charge: overtimeCharge,
        message: 'Overtime charges applied'
      } : null
    });
  } catch (err) {
    console.error('Check-out error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error checking out booking');
  }
};

/**
 * @desc    Extend booking
 * @route   PUT /api/bookings/:id/extend
 * @access  Private/Owner
 */
exports.extendBooking = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { new_end_time } = req.body;

    if (!new_end_time) {
      return error(res, errorCodes.REQ_VALIDATION, 400, 'New end time is required');
    }

    // Find booking
    const booking = await Booking.findById(id).populate('space_id');

    if (!booking) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Booking not found');
    }

    // Check authorization
    if (booking.user_id.toString() !== req.user._id.toString() && req.user.user_type !== 'admin') {
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to extend this booking');
    }

    // Only allow extension for confirmed or active bookings
    if (!['confirmed', 'active'].includes(booking.status)) {
      return error(res, errorCodes.BIZ_OPERATION_NOT_ALLOWED, 400, 'Can only extend confirmed or active bookings');
    }

    const newEndDate = new Date(new_end_time);
    const now = new Date();

    // Validate new end time
    if (isNaN(newEndDate.getTime())) {
      return error(res, errorCodes.REQ_VALIDATION, 400, 'Invalid date format');
    }

    if (newEndDate <= booking.end_time) {
      return error(res, errorCodes.BIZ_VALIDATION, 400, 'New end time must be after current end time');
    }

    if (newEndDate <= now) {
      return error(res, errorCodes.BIZ_VALIDATION, 400, 'New end time must be in the future');
    }

    // Check for conflicts with extended time
    const conflict = await hasBookingConflict(booking.space_id._id, booking.end_time, newEndDate, booking._id);
    if (conflict) {
      return error(res, errorCodes.BIZ_CONFLICT, 409, 'Cannot extend: parking space is already booked for the requested time period');
    }

    // Calculate additional price for extension
    const extensionMs = newEndDate - booking.end_time;
    const extensionHours = extensionMs / (1000 * 60 * 60);
    const extensionPrice = calculateBookingPrice(booking.space_id, extensionHours);

    // Update booking
    const oldEndTime = booking.end_time;
    booking.end_time = newEndDate;
    booking.total_price += extensionPrice;
    booking.final_price += extensionPrice;

    // Track extension in metadata
    if (!booking.extensions) {
      booking.extensions = [];
    }
    booking.extensions.push({
      old_end_time: oldEndTime,
      new_end_time: newEndDate,
      extension_price: extensionPrice,
      extended_at: now
    });

    await booking.save();

    // Populate and return extended booking
    const extendedBooking = await Booking.findById(id)
      .populate('user_id', 'email first_name last_name phone')
      .populate('owner_id', 'business_name')
      .populate('space_id', 'space_number space_type hourly_rate daily_rate monthly_rate')
      .populate('vehicle_id', 'vehicle_make vehicle_model license_plate');

    return success(res, {
      booking: extendedBooking,
      extension: {
        old_end_time: oldEndTime,
        new_end_time: newEndDate,
        additional_charge: extensionPrice
      }
    });
  } catch (err) {
    console.error('Extend booking error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error extending booking');
  }
};
