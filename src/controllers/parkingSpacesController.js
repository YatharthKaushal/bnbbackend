/**
 * Parking Spaces Controller
 * Handles parking space CRUD, pricing, and search operations
 */

const ParkingSpace = require('../models/ParkingSpace');
const Property = require('../models/Property');
const Owner = require('../models/Owner');
const Booking = require('../models/Booking');
const { success, error, paginationMeta } = require('../utils/responseHelper');
const errorCodes = require('../utils/errorCodes');

/**
 * @desc    Get all parking spaces
 * @route   GET /api/parking-spaces
 * @access  Public
 */
exports.getAllSpaces = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 20,
      is_available,
      space_type,
      min_price,
      max_price,
      has_ev_charging,
      city,
      state
    } = req.query;

    const validPage = Math.max(1, parseInt(page));
    const validLimit = Math.min(100, Math.max(1, parseInt(limit)));

    // Build filter
    const filter = {};

    if (is_available !== undefined) {
      filter.is_available = is_available === 'true';
    }

    if (space_type) {
      filter.space_type = space_type;
    }

    if (has_ev_charging !== undefined) {
      filter.has_ev_charging = has_ev_charging === 'true';
    }

    // Price range filter
    if (min_price || max_price) {
      filter.price_per_hour = {};
      if (min_price) filter.price_per_hour.$gte = parseFloat(min_price);
      if (max_price) filter.price_per_hour.$lte = parseFloat(max_price);
    }

    // Get total count
    const total = await ParkingSpace.countDocuments(filter);

    // Get spaces with populated property for location filtering
    let query = ParkingSpace.find(filter)
      .populate('property_id', 'property_name address city state location_lat location_lng')
      .populate('owner_id', 'business_name user_id')
      .sort({ created_at: -1 })
      .skip((validPage - 1) * validLimit)
      .limit(validLimit);

    let spaces = await query;

    // Filter by city/state if provided
    if (city || state) {
      spaces = spaces.filter(space => {
        if (!space.property_id) return false;
        if (city && space.property_id.city.toLowerCase() !== city.toLowerCase()) return false;
        if (state && space.property_id.state.toLowerCase() !== state.toLowerCase()) return false;
        return true;
      });
    }

    const meta = paginationMeta(validPage, validLimit, total);

    return success(res, { spaces }, meta);
  } catch (err) {
    console.error('Get all spaces error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error fetching parking spaces');
  }
};

/**
 * @desc    Get parking space by ID
 * @route   GET /api/parking-spaces/:id
 * @access  Public
 */
exports.getSpaceById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const space = await ParkingSpace.findById(id)
      .populate('property_id', 'property_name address city state postal_code location_lat location_lng access_instructions property_images')
      .populate('owner_id', 'business_name average_rating user_id');

    if (!space) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Parking space not found');
    }

    return success(res, { space });
  } catch (err) {
    console.error('Get space by ID error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error fetching parking space');
  }
};

/**
 * @desc    Get spaces by property
 * @route   GET /api/parking-spaces/properties/:propertyId
 * @access  Public
 */
exports.getSpacesByProperty = async (req, res, next) => {
  try {
    const { propertyId } = req.params;
    const { is_available } = req.query;

    // Check if property exists
    const property = await Property.findById(propertyId);
    if (!property) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Property not found');
    }

    // Build filter
    const filter = { property_id: propertyId };
    if (is_available !== undefined) {
      filter.is_available = is_available === 'true';
    }

    const spaces = await ParkingSpace.find(filter)
      .populate('owner_id', 'business_name average_rating')
      .sort({ space_number: 1 });

    return success(res, {
      property: {
        _id: property._id,
        property_name: property.property_name,
        address: property.address,
        city: property.city,
        state: property.state
      },
      spaces
    });
  } catch (err) {
    console.error('Get spaces by property error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error fetching property spaces');
  }
};

/**
 * @desc    Create parking space
 * @route   POST /api/parking-spaces/properties/:propertyId/spaces
 * @access  Private/Owner
 */
exports.createSpace = async (req, res, next) => {
  console.log('[createSpace] Request received');
  console.log('[createSpace] User ID:', req.user?._id);
  console.log('[createSpace] User type:', req.user?.user_type);
  console.log('[createSpace] Property ID (params):', req.params.propertyId);
  console.log('[createSpace] Request body:', JSON.stringify(req.body, null, 2));

  try {
    const { propertyId } = req.params;
    const {
      space_number,
      space_type,
      length_meters,
      width_meters,
      height_meters,
      allowed_vehicle_types,
      space_description,
      space_images,
      price_per_hour,
      price_per_day,
      price_per_month,
      booking_mode,
      has_ev_charging,
      is_available
    } = req.body;

    console.log('[createSpace] Extracted data - space_number:', space_number, ', space_type:', space_type, ', price_per_hour:', price_per_hour);

    // Check if property exists
    console.log('[createSpace] Looking up property with ID:', propertyId);
    const property = await Property.findById(propertyId).populate('owner_id');
    if (!property) {
      console.log('[createSpace] ERROR: Property not found for ID:', propertyId);
      return error(res, errorCodes.NOT_FOUND, 404, 'Property not found');
    }
    console.log('[createSpace] Property found:', property.property_name);

    // Check authorization - user must be the property owner or admin
    const propertyOwnerUserId = property.owner_id && property.owner_id.user_id ?
      property.owner_id.user_id.toString() : null;
    console.log('[createSpace] Property owner user_id:', propertyOwnerUserId);
    console.log('[createSpace] Request user_id:', req.user._id.toString());

    if (req.user.user_type !== 'admin' && propertyOwnerUserId !== req.user._id.toString()) {
      console.log('[createSpace] ERROR: User not authorized - not owner and not admin');
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to create spaces for this property');
    }
    console.log('[createSpace] Authorization check passed');

    // Check if space number already exists for this property
    console.log('[createSpace] Checking for duplicate space_number:', space_number);
    const existingSpace = await ParkingSpace.findOne({
      property_id: propertyId,
      space_number
    });

    if (existingSpace) {
      console.log('[createSpace] ERROR: Space number already exists - existing space_id:', existingSpace._id);
      return error(res, errorCodes.BIZ_CONFLICT, 409, 'Space number already exists for this property');
    }
    console.log('[createSpace] No duplicate space_number found');

    // Get owner ID
    console.log('[createSpace] Looking up owner for user_id:', req.user._id);
    const owner = await Owner.findOne({ user_id: req.user._id });
    console.log('[createSpace] Owner lookup result:', owner ? `Found owner_id: ${owner._id}` : 'Not found');

    if (!owner && req.user.user_type !== 'admin') {
      console.log('[createSpace] ERROR: User is not registered as owner and not admin');
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'User must be registered as an owner to create parking spaces');
    }

    const ownerId = owner ? owner._id : property.owner_id._id;
    console.log('[createSpace] Using owner_id:', ownerId);

    // Create parking space
    console.log('[createSpace] Creating parking space in database...');
    const space = await ParkingSpace.create({
      property_id: propertyId,
      owner_id: ownerId,
      space_number,
      space_type,
      length_meters,
      width_meters,
      height_meters,
      allowed_vehicle_types: allowed_vehicle_types || [],
      space_description,
      space_images: space_images || [],
      price_per_hour,
      price_per_day,
      price_per_month,
      hourly_rate: price_per_hour, // Alias
      daily_rate: price_per_day,   // Alias
      monthly_rate: price_per_month, // Alias
      booking_mode: booking_mode || 'instant',
      has_ev_charging: has_ev_charging || false,
      is_available: is_available !== undefined ? is_available : true,
      status: is_available !== undefined ? (is_available ? 'active' : 'inactive') : 'active',
      average_rating: 0
    });
    console.log('[createSpace] Parking space created with _id:', space._id);

    console.log('[createSpace] SUCCESS: Returning space with status 201');
    return success(res, { space }, null, 201);
  } catch (err) {
    console.log('[createSpace] ERROR: Exception caught');
    console.log('[createSpace] Error name:', err.name);
    console.log('[createSpace] Error message:', err.message);
    console.log('[createSpace] Error stack:', err.stack);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error creating parking space');
  }
};

/**
 * @desc    Update parking space
 * @route   PUT /api/parking-spaces/:id
 * @access  Private/Owner
 */
exports.updateSpace = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      space_number,
      space_type,
      length_meters,
      width_meters,
      height_meters,
      allowed_vehicle_types,
      space_description,
      space_images,
      price_per_hour,
      price_per_day,
      price_per_month,
      booking_mode,
      has_ev_charging,
      is_available
    } = req.body;

    // Get parking space
    const space = await ParkingSpace.findById(id).populate('owner_id', 'user_id');

    if (!space) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Parking space not found');
    }

    // Check authorization - user must be the space owner or admin
    const spaceOwnerUserId = space.owner_id && space.owner_id.user_id ?
      space.owner_id.user_id.toString() : null;

    if (req.user.user_type !== 'admin' && spaceOwnerUserId !== req.user._id.toString()) {
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to update this parking space');
    }

    // Check if space number change would cause conflict
    if (space_number && space_number !== space.space_number) {
      const existingSpace = await ParkingSpace.findOne({
        property_id: space.property_id,
        space_number,
        _id: { $ne: id }
      });

      if (existingSpace) {
        return error(res, errorCodes.BIZ_CONFLICT, 409, 'Space number already exists for this property');
      }
    }

    // Update fields
    if (space_number) space.space_number = space_number;
    if (space_type) space.space_type = space_type;
    if (length_meters !== undefined) space.length_meters = length_meters;
    if (width_meters !== undefined) space.width_meters = width_meters;
    if (height_meters !== undefined) space.height_meters = height_meters;
    if (allowed_vehicle_types) space.allowed_vehicle_types = allowed_vehicle_types;
    if (space_description !== undefined) space.space_description = space_description;
    if (space_images) space.space_images = space_images;
    if (price_per_hour !== undefined) {
      space.price_per_hour = price_per_hour;
      space.hourly_rate = price_per_hour;
    }
    if (price_per_day !== undefined) {
      space.price_per_day = price_per_day;
      space.daily_rate = price_per_day;
    }
    if (price_per_month !== undefined) {
      space.price_per_month = price_per_month;
      space.monthly_rate = price_per_month;
    }
    if (booking_mode) space.booking_mode = booking_mode;
    if (has_ev_charging !== undefined) space.has_ev_charging = has_ev_charging;
    if (is_available !== undefined) {
      space.is_available = is_available;
      space.status = is_available ? 'active' : 'inactive';
    }

    await space.save();

    return success(res, { space });
  } catch (err) {
    console.error('Update space error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error updating parking space');
  }
};

/**
 * @desc    Delete parking space (soft delete)
 * @route   DELETE /api/parking-spaces/:id
 * @access  Private/Owner or Admin
 */
exports.deleteSpace = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Get parking space
    const space = await ParkingSpace.findById(id).populate('owner_id', 'user_id');

    if (!space) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Parking space not found');
    }

    // Check authorization - user must be the space owner or admin
    const spaceOwnerUserId = space.owner_id && space.owner_id.user_id ?
      space.owner_id.user_id.toString() : null;

    if (req.user.user_type !== 'admin' && spaceOwnerUserId !== req.user._id.toString()) {
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to delete this parking space');
    }

    // Check for active bookings
    const activeBookings = await Booking.countDocuments({
      space_id: id,
      status: { $in: ['confirmed', 'active'] }
    });

    if (activeBookings > 0) {
      return error(res, errorCodes.BIZ_CONFLICT, 409, 'Cannot delete space with active bookings');
    }

    // Soft delete - mark as unavailable
    space.is_available = false;
    space.status = 'unavailable';
    await space.save();

    return success(res, {
      message: 'Parking space deleted successfully',
      space
    });
  } catch (err) {
    console.error('Delete space error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error deleting parking space');
  }
};

/**
 * @desc    Search available parking spaces
 * @route   GET /api/parking-spaces/search
 * @access  Public
 */
exports.searchSpaces = async (req, res, next) => {
  try {
    const {
      lat,
      lng,
      radius = 10, // km
      start_date,
      end_date,
      vehicle_type,
      min_price,
      max_price,
      space_type,
      has_ev_charging,
      page = 1,
      limit = 20
    } = req.query;

    const validPage = Math.max(1, parseInt(page));
    const validLimit = Math.min(100, Math.max(1, parseInt(limit)));

    // Build filter
    const filter = { is_available: true };

    // Vehicle type filter
    if (vehicle_type) {
      filter.allowed_vehicle_types = vehicle_type;
    }

    // Space type filter
    if (space_type) {
      filter.space_type = space_type;
    }

    // Price range filter
    if (min_price || max_price) {
      filter.price_per_hour = {};
      if (min_price) filter.price_per_hour.$gte = parseFloat(min_price);
      if (max_price) filter.price_per_hour.$lte = parseFloat(max_price);
    }

    // EV charging filter
    if (has_ev_charging !== undefined) {
      filter.has_ev_charging = has_ev_charging === 'true';
    }

    // Get all matching spaces with property data
    let spaces = await ParkingSpace.find(filter)
      .populate('property_id', 'property_name address city state postal_code location_lat location_lng')
      .populate('owner_id', 'business_name average_rating');

    // Location-based filtering
    if (lat && lng) {
      const latitude = parseFloat(lat);
      const longitude = parseFloat(lng);
      const radiusKm = parseFloat(radius);

      spaces = spaces.filter(space => {
        if (!space.property_id) return false;

        const distance = calculateDistance(
          latitude,
          longitude,
          space.property_id.location_lat,
          space.property_id.location_lng
        );

        return distance <= radiusKm;
      });
    }

    // Date availability filtering
    if (start_date && end_date) {
      const startDateTime = new Date(start_date);
      const endDateTime = new Date(end_date);

      // Filter out spaces with conflicting bookings
      const availableSpaces = [];

      for (const space of spaces) {
        const conflictingBooking = await Booking.findOne({
          space_id: space._id,
          status: { $nin: ['cancelled', 'completed', 'no_show'] },
          $or: [
            { start_time: { $lte: startDateTime }, end_time: { $gt: startDateTime } },
            { start_time: { $lt: endDateTime }, end_time: { $gte: endDateTime } },
            { start_time: { $gte: startDateTime }, end_time: { $lte: endDateTime } }
          ]
        });

        if (!conflictingBooking) {
          availableSpaces.push(space);
        }
      }

      spaces = availableSpaces;
    }

    // Pagination
    const total = spaces.length;
    const paginatedSpaces = spaces.slice(
      (validPage - 1) * validLimit,
      validPage * validLimit
    );

    const meta = paginationMeta(validPage, validLimit, total);

    return success(res, { spaces: paginatedSpaces }, meta);
  } catch (err) {
    console.error('Search spaces error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error searching parking spaces');
  }
};

/**
 * @desc    Check space availability
 * @route   GET /api/parking-spaces/:id/availability
 * @access  Public
 */
exports.checkAvailability = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { start_date, end_date } = req.query;

    // Validate dates
    if (!start_date || !end_date) {
      return error(res, errorCodes.REQ_VALIDATION, 400, 'Start date and end date are required');
    }

    const startDateTime = new Date(start_date);
    const endDateTime = new Date(end_date);

    if (startDateTime >= endDateTime) {
      return error(res, errorCodes.REQ_VALIDATION, 400, 'End date must be after start date');
    }

    // Get parking space
    const space = await ParkingSpace.findById(id);

    if (!space) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Parking space not found');
    }

    // Check if space is generally available
    if (!space.is_available) {
      return success(res, {
        available: false,
        reason: 'Space is currently unavailable'
      });
    }

    // Check for conflicting bookings
    const conflictingBooking = await Booking.findOne({
      space_id: id,
      status: { $nin: ['cancelled', 'completed', 'no_show'] },
      $or: [
        { start_time: { $lte: startDateTime }, end_time: { $gt: startDateTime } },
        { start_time: { $lt: endDateTime }, end_time: { $gte: endDateTime } },
        { start_time: { $gte: startDateTime }, end_time: { $lte: endDateTime } }
      ]
    });

    if (conflictingBooking) {
      return success(res, {
        available: false,
        reason: 'Space is booked during the requested time period',
        conflicting_booking: {
          start_time: conflictingBooking.start_time,
          end_time: conflictingBooking.end_time
        }
      });
    }

    // Calculate price for the requested duration
    const durationMs = endDateTime - startDateTime;
    const durationHours = durationMs / (1000 * 60 * 60);

    let estimated_price = 0;
    if (durationHours <= 24) {
      estimated_price = space.price_per_hour * durationHours;
    } else if (durationHours <= 24 * 30) {
      const days = Math.ceil(durationHours / 24);
      estimated_price = space.price_per_day * days;
    } else {
      const months = Math.ceil(durationHours / (24 * 30));
      estimated_price = space.price_per_month * months;
    }

    return success(res, {
      available: true,
      space_id: space._id,
      duration_hours: Math.round(durationHours * 100) / 100,
      estimated_price: Math.round(estimated_price * 100) / 100,
      booking_mode: space.booking_mode
    });
  } catch (err) {
    console.error('Check availability error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error checking availability');
  }
};

/**
 * @desc    Update pricing
 * @route   PUT /api/parking-spaces/:id/pricing
 * @access  Private/Owner
 */
exports.updatePricing = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { price_per_hour, price_per_day, price_per_month } = req.body;

    // Validate that at least one price is provided
    if (price_per_hour === undefined && price_per_day === undefined && price_per_month === undefined) {
      return error(res, errorCodes.REQ_VALIDATION, 400, 'At least one price field is required');
    }

    // Get parking space
    const space = await ParkingSpace.findById(id).populate('owner_id', 'user_id');

    if (!space) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Parking space not found');
    }

    // Check authorization - user must be the space owner or admin
    const spaceOwnerUserId = space.owner_id && space.owner_id.user_id ?
      space.owner_id.user_id.toString() : null;

    if (req.user.user_type !== 'admin' && spaceOwnerUserId !== req.user._id.toString()) {
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to update pricing for this space');
    }

    // Update pricing
    if (price_per_hour !== undefined) {
      space.price_per_hour = price_per_hour;
      space.hourly_rate = price_per_hour;
    }
    if (price_per_day !== undefined) {
      space.price_per_day = price_per_day;
      space.daily_rate = price_per_day;
    }
    if (price_per_month !== undefined) {
      space.price_per_month = price_per_month;
      space.monthly_rate = price_per_month;
    }

    await space.save();

    return success(res, {
      message: 'Pricing updated successfully',
      space
    });
  } catch (err) {
    console.error('Update pricing error:', err);
    return error(res, errorCodes.SERVER_ERROR, 500, 'Error updating pricing');
  }
};

// Helper function to calculate distance between two points (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return distance;
}

function toRad(degrees) {
  return degrees * (Math.PI / 180);
}
