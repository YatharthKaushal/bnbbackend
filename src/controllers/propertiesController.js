/**
 * Properties Controller
 * Handles property CRUD operations and geospatial search
 */

const Property = require('../models/Property');
const Owner = require('../models/Owner');
const ParkingSpace = require('../models/ParkingSpace');
const { success, error, paginationMeta } = require('../utils/responseHelper');
const errorCodes = require('../utils/errorCodes');

/**
 * @desc    Get all properties
 * @route   GET /api/properties
 * @access  Public
 */
exports.getAllProperties = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Filter options
    const filter = { is_active: true };

    if (req.query.city) {
      filter.city = new RegExp(req.query.city, 'i');
    }

    if (req.query.state) {
      filter.state = new RegExp(req.query.state, 'i');
    }

    if (req.query.owner_id) {
      filter.owner_id = req.query.owner_id;
    }

    // Get total count
    const total = await Property.countDocuments(filter);

    // Get properties with pagination
    const properties = await Property.find(filter)
      .populate('owner_id', 'user_id is_verified')
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit);

    return success(res, {
      properties
    }, paginationMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Get property by ID
 * @route   GET /api/properties/:id
 * @access  Public
 */
exports.getPropertyById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const property = await Property.findById(id)
      .populate('owner_id', 'user_id is_verified average_rating');

    if (!property) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Property not found');
    }

    if (!property.is_active) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Property not available');
    }

    // Get parking spaces count for this property
    const totalSpaces = await ParkingSpace.countDocuments({
      property_id: id,
      availability_status: 'available'
    });

    const propertyData = property.toObject();
    propertyData.available_spaces = totalSpaces;

    return success(res, { property: propertyData });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Create new property
 * @route   POST /api/properties
 * @access  Private/Owner
 */
exports.createProperty = async (req, res, next) => {
  console.log('[createProperty] Request received');
  console.log('[createProperty] User ID:', req.user?._id);
  console.log('[createProperty] User type:', req.user?.user_type);
  console.log('[createProperty] Request body:', JSON.stringify(req.body, null, 2));

  try {
    const {
      property_name,
      address,
      city,
      state,
      postal_code,
      location_lat,
      location_lng,
      access_instructions,
      property_images
    } = req.body;

    console.log('[createProperty] Extracted data - property_name:', property_name, ', city:', city, ', state:', state);

    // Check if user is an owner
    console.log('[createProperty] Looking up owner for user_id:', req.user._id);
    const owner = await Owner.findOne({ user_id: req.user._id });
    console.log('[createProperty] Owner lookup result:', owner ? `Found owner_id: ${owner._id}` : 'Not found');

    if (!owner && req.user.user_type !== 'admin') {
      console.log('[createProperty] ERROR: User is not an owner and not an admin');
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Only property owners can create properties');
    }

    const ownerId = owner ? owner._id : req.body.owner_id;
    console.log('[createProperty] Using owner_id:', ownerId);

    if (!ownerId) {
      console.log('[createProperty] ERROR: Owner ID is required but not provided');
      return error(res, errorCodes.REQ_VALIDATION, 400, 'Owner ID is required');
    }

    // Create property
    console.log('[createProperty] Creating property in database...');
    const property = await Property.create({
      owner_id: ownerId,
      property_name,
      address,
      city,
      state,
      postal_code,
      location_lat,
      location_lng,
      access_instructions,
      property_images: property_images || [],
      is_active: true
    });
    console.log('[createProperty] Property created with _id:', property._id);

    const populatedProperty = await Property.findById(property._id)
      .populate('owner_id', 'user_id is_verified');
    console.log('[createProperty] Property populated successfully');

    console.log('[createProperty] SUCCESS: Returning property with status 201');
    return success(res, { property: populatedProperty }, null, 201);
  } catch (err) {
    console.log('[createProperty] ERROR: Exception caught');
    console.log('[createProperty] Error name:', err.name);
    console.log('[createProperty] Error message:', err.message);
    console.log('[createProperty] Error stack:', err.stack);
    next(err);
  }
};

/**
 * @desc    Update property
 * @route   PUT /api/properties/:id
 * @access  Private/Owner
 */
exports.updateProperty = async (req, res, next) => {
  try {
    const { id } = req.params;

    const property = await Property.findById(id).populate('owner_id');

    if (!property) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Property not found');
    }

    // Check authorization
    const ownerUserId = property.owner_id && property.owner_id.user_id ?
      property.owner_id.user_id.toString() : null;

    if (req.user.user_type !== 'admin' && ownerUserId !== req.user._id.toString()) {
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to update this property');
    }

    const {
      property_name,
      address,
      city,
      state,
      postal_code,
      location_lat,
      location_lng,
      access_instructions,
      property_images
    } = req.body;

    // Update fields
    if (property_name !== undefined) property.property_name = property_name;
    if (address !== undefined) property.address = address;
    if (city !== undefined) property.city = city;
    if (state !== undefined) property.state = state;
    if (postal_code !== undefined) property.postal_code = postal_code;
    if (location_lat !== undefined) property.location_lat = location_lat;
    if (location_lng !== undefined) property.location_lng = location_lng;
    if (access_instructions !== undefined) property.access_instructions = access_instructions;
    if (property_images !== undefined) property.property_images = property_images;

    await property.save();

    const updatedProperty = await Property.findById(id)
      .populate('owner_id', 'user_id is_verified');

    return success(res, { property: updatedProperty });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Delete property (soft delete)
 * @route   DELETE /api/properties/:id
 * @access  Private/Owner or Admin
 */
exports.deleteProperty = async (req, res, next) => {
  try {
    const { id } = req.params;

    const property = await Property.findById(id).populate('owner_id');

    if (!property) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Property not found');
    }

    // Check authorization
    const ownerUserId = property.owner_id && property.owner_id.user_id ?
      property.owner_id.user_id.toString() : null;

    if (req.user.user_type !== 'admin' && ownerUserId !== req.user._id.toString()) {
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to delete this property');
    }

    // Check for active parking spaces
    const activeSpaces = await ParkingSpace.countDocuments({
      property_id: id,
      availability_status: 'available'
    });

    if (activeSpaces > 0) {
      return error(res, errorCodes.BIZ_CONFLICT, 409,
        `Cannot delete property with ${activeSpaces} active parking spaces. Please remove or deactivate spaces first.`);
    }

    // Soft delete
    property.is_active = false;
    await property.save();

    return success(res, {
      message: 'Property deleted successfully',
      property_id: id
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Get properties by owner
 * @route   GET /api/properties/owners/:ownerId
 * @access  Private
 */
exports.getPropertiesByOwner = async (req, res, next) => {
  try {
    const { ownerId } = req.params;

    // Check if owner exists
    const owner = await Owner.findById(ownerId);

    if (!owner) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Owner not found');
    }

    // Check authorization
    if (req.user.user_type !== 'admin' && owner.user_id.toString() !== req.user._id.toString()) {
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to view these properties');
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Filter by is_active if provided
    const filter = { owner_id: ownerId };
    if (req.query.is_active !== undefined) {
      filter.is_active = req.query.is_active === 'true';
    }

    const total = await Property.countDocuments(filter);

    const properties = await Property.find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit);

    // Get spaces count for each property
    const propertiesWithSpaces = await Promise.all(
      properties.map(async (property) => {
        const spacesCount = await ParkingSpace.countDocuments({
          property_id: property._id
        });
        const propertyData = property.toObject();
        propertyData.total_spaces = spacesCount;
        return propertyData;
      })
    );

    return success(res, {
      properties: propertiesWithSpaces
    }, paginationMeta(page, limit, total));
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Search properties by location (geospatial)
 * @route   GET /api/properties/search/nearby
 * @access  Public
 */
exports.searchNearby = async (req, res, next) => {
  try {
    const { lat, lng, radius } = req.query;

    if (!lat || !lng) {
      return error(res, errorCodes.REQ_VALIDATION, 400, 'Latitude and longitude are required');
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    const radiusKm = parseFloat(radius) || 10; // Default 10km

    // Find all active properties
    const properties = await Property.find({ is_active: true })
      .populate('owner_id', 'user_id is_verified average_rating');

    // Calculate distance and filter by radius
    const propertiesWithDistance = properties
      .map(property => {
        const distance = calculateDistance(
          latitude,
          longitude,
          property.location_lat,
          property.location_lng
        );

        return {
          ...property.toObject(),
          distance_km: Math.round(distance * 100) / 100
        };
      })
      .filter(property => property.distance_km <= radiusKm)
      .sort((a, b) => a.distance_km - b.distance_km);

    // Get spaces count for each property
    const propertiesWithSpaces = await Promise.all(
      propertiesWithDistance.map(async (property) => {
        const availableSpaces = await ParkingSpace.countDocuments({
          property_id: property._id,
          availability_status: 'available'
        });
        return {
          ...property,
          available_spaces: availableSpaces
        };
      })
    );

    return success(res, {
      properties: propertiesWithSpaces,
      search_params: {
        latitude,
        longitude,
        radius_km: radiusKm
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * @desc    Upload property images
 * @route   POST /api/properties/:id/images
 * @access  Private/Owner
 */
exports.uploadImages = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { images } = req.body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return error(res, errorCodes.REQ_VALIDATION, 400, 'Images array is required');
    }

    const property = await Property.findById(id).populate('owner_id');

    if (!property) {
      return error(res, errorCodes.NOT_FOUND, 404, 'Property not found');
    }

    // Check authorization
    const ownerUserId = property.owner_id && property.owner_id.user_id ?
      property.owner_id.user_id.toString() : null;

    if (req.user.user_type !== 'admin' && ownerUserId !== req.user._id.toString()) {
      return error(res, errorCodes.AUTH_FORBIDDEN, 403, 'Not authorized to upload images for this property');
    }

    // Add new images to existing ones
    property.property_images = [...property.property_images, ...images];
    await property.save();

    return success(res, {
      message: 'Images uploaded successfully',
      property_images: property.property_images
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Helper function to calculate distance between two coordinates using Haversine formula
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lon1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lon2 - Longitude of point 2
 * @returns {number} Distance in kilometers
 */
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
