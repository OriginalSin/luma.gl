// VertexArray class

import GL from '../constants';
import Accessor from './accessor';
import Buffer from './buffer';
import VertexArrayObject from './vertex-array-object';
import {glKey} from '../webgl-utils/constants-to-keys';
import {getCompositeGLType} from '../webgl-utils/attribute-utils';
import {log, formatValue, assert} from '../utils';
import {stubRemovedMethods} from '../utils';

const ERR_ATTRIBUTE_TYPE =
  'VertexArray: attributes must be Buffers or constants (i.e. typed array)';

export default class VertexArray {
  constructor(gl, opts = {}) {
    // Use program's id if program is supplied but no id is supplied
    const id = opts.id || opts.program && opts.program.id;
    // super(gl, Object.assign({}, opts, {id}));

    this.id = id;
    this.gl = gl;
    this.configuration = null;

    // Extracted information
    this.elements = null;
    this.values = null;
    this.accessors = null;
    this.unused = null;
    this.drawParams = null;
    this.buffer = null; // For attribute 0 on desktops, and created when unbinding buffers

    this.vertexArrayObject = VertexArrayObject.isSupported(gl) ?
      new VertexArrayObject(gl) :
      VertexArrayObject.getDefaultArray(gl);

    // Issue errors when using removed methods
    stubRemovedMethods(this, 'VertexArray', 'v6.0', [
      'setBuffers', 'setGeneric', 'clearBindings', 'setLocations', 'setGenericValues',
      'setDivisor', 'enable', 'disable'
    ]);

    this.initialize(opts);
    Object.seal(this);
  }

  delete() {
    if (this.buffer) {
      this.buffer.delete();
    }
  }

  initialize(props = {}) {
    this.reset();
    this.configuration = null;
    this.bindOnUse = false;
    return this.setProps(props);
  }

  // Resets all attributes (to default valued constants)
  reset() {
    // this.vertexArrayObject.reset();

    this.elements = null;
    const {MAX_ATTRIBUTES} = this.vertexArrayObject;
    this.values = new Array(MAX_ATTRIBUTES).fill(null);
    this.accessors = new Array(MAX_ATTRIBUTES).fill(null);
    this.unused = {};

    // Auto detects draw params
    this.drawParams = null;

    return this;
  }

  setProps(props) {
    if ('program' in props) {
      this.configuration = props.program && props.program.configuration;
    }
    if ('configuration' in props) {
      this.configuration = props.configuration;
    }
    if ('attributes' in props) {
      this.setAttributes(props.attributes);
    }
    if ('elements' in props) {
      this.setElements(props.elements);
    }
    if ('bindOnUse' in props) {
      props = props.bindOnUse;
    }
    return this;
  }

  // Automatically called if buffers changed through VertexArray API
  clearDrawParams() {
    this.drawParams = null;
  }

  getDrawParams(vertexCount) {
    this.drawParams = this.drawParams || this._updateDrawParams();
    this._updateAttributeZeroBuffer(vertexCount || this.drawParams.vertexCount);
    return this.drawParams;
  }

  // Set (bind) an array or map of vertex array buffers, either in numbered or named locations.
  // For names that are not present in `location`, the supplied buffers will be ignored.
  // if a single buffer of type GL.ELEMENT_ARRAY_BUFFER is present, it will be set as elements
  //   Signatures:
  //     {attributeName: buffer}
  //     {attributeName: [buffer, accessor]}
  //     {attributeName: (typed) array} => constant
  setAttributes(attributes) {
    this.vertexArrayObject.bind(() => {
      for (const locationOrName in attributes) {
        const value = attributes[locationOrName];
        if (value instanceof Buffer) {
          //  Signature: attributeName: buffer
          this.setBuffer(locationOrName, value);
        } else if (Array.isArray(value) && value.length && value[0] instanceof Buffer) {
          // Signature: attributeName: [buffer, accessor]
          const buffer = value[0];
          const accessor = value[1];
          this.setBuffer(locationOrName, buffer, accessor);
        } else if (ArrayBuffer.isView(value) || Array.isArray(value)) {
          //  Signature: attributeName: (short) (typed) array => constant
          this.setConstant(locationOrName, value);
        } else {
          throw new Error(ERR_ATTRIBUTE_TYPE);
        }
      }

      // Make sure we don't leave any bindings
      this.gl.bindBuffer(GL.ARRAY_BUFFER, null);
    });

    return this;
  }

  // Set (bind) an elements buffer, for indexed rendering.
  // Must be a Buffer bound to GL.ELEMENT_ARRAY_BUFFER. Constants not supported
  setElementBuffer(elementBuffer = null, accessor = {}) {
    this.elements = elementBuffer; // Save value for debugging
    this.clearDrawParams();
    // Update vertexArray immediately if we have our own array
    if (!this.vertexArrayObject.isDefaultArray) {
      this.vertexArrayObject.setElementBuffer(elementBuffer, accessor);
    }
    return this;
  }

  // Set a location in vertex attributes array to a buffer
  setBuffer(locationOrName, buffer, optAccessor = {}) {
    // Check target
    if (buffer.target === GL.ELEMENT_ARRAY_BUFFER) {
      return this.setElements(buffer);
    }

    const {location, accessor} =
      this._resolveLocationAndAccessor(locationOrName, buffer, buffer.accessor, optAccessor);

    if (location >= 0) {
      this.values[location] = buffer;
      this.accessors[location] = accessor;
      this.clearDrawParams();
      // Update vertexArray immediately if we have our own array
      if (!this.vertexArrayObject.isDefaultArray) {
        this.vertexArrayObject.setBuffer(location, buffer, accessor);
      }
    }

    return this;
  }

  // Set attribute to constant value (small typed array corresponding to one vertex' worth of data)
  setConstant(locationOrName, arrayValue, optAccessor = {}) {
    const {location, accessor} =
      this._resolveLocationAndAccessor(locationOrName, arrayValue, {}, optAccessor);

    if (location >= 0) {
      arrayValue = this.vertexArrayObject._normalizeConstantArrayValue(arrayValue, accessor);

      this.values[location] = arrayValue;
      this.accessors[location] = accessor;
      this.clearDrawParams();

      // Update vertexArray immediately if we have our own array
      // NOTE: We set the actual constant value later on bind. We can't set the value now since
      // constants are global and affect all other VertexArrays that have disabled attributes
      // in the same location.
      // We do disable the attribute which makes it use the global constant value at that location
      if (!this.vertexArrayObject.isDefaultArray) {
        this.vertexArrayObject.enable(location, false);
      }
    }

    return this;
  }

  // Workaround for Chrome TransformFeedback binding issue
  // If required, unbind temporarily to avoid conflicting with TransformFeedback
  unbindBuffers() {
    this.vertexArrayObject.bind(() => {
      // Chrome does not like buffers that are bound to several binding points,
      // so we need to offer and unbind facility
      // WebGL offers disabling, but no clear way to set a VertexArray buffer to `null`
      // So we just bind all the attributes to the dummy "attribute zero" buffer
      this.buffer = this.buffer || new Buffer(this.gl, {size: 4});

      for (let location = 0; location < this.vertexArrayObject.MAX_ATTRIBUTES; location++) {
        if (this.values[location] instanceof Buffer) {
          this.gl.disableVertexAttribArray(location);
          this.gl.bindBuffer(GL.ARRAY_BUFFER, this.buffer.handle);
          this.gl.vertexAttribPointer(location, 1, GL.FLOAT, false, 0, 0);
        }
      }
    });
    return this;
  }

  // Workaround for Chrome TransformFeedback binding issue
  // If required, rebind rebind after temporary unbind
  bindBuffers() {
    this.vertexArrayObject.bind(() => {
      for (let location = 0; location < this.vertexArrayObject.MAX_ATTRIBUTES; location++) {
        const buffer = this.values[location];
        if (buffer instanceof Buffer) {
          this.setBuffer(location, buffer);
        }
      }
    });
    return this;
  }

  // Bind for use
  // When a vertex array is about to be used, we must:
  // - Set constant attributes (since these are stored on the context and reset on bind)
  // - Check if we need to initialize the buffer
  bind(func) {
    return this.bindForUse(4, func);
  }

  bindForUse(length, func) {
    if (Number.isFinite(length)) {
      this._updateAttributeZeroBuffer(length);
    }

    // Make sure that any constant attributes are updated (stored on the context, not the VAO)
    this._setConstantAttributes();

    if (!this.hasVertexArrays) {
      if (this.elements) {
        this.setElementBuffer(this.elements);
      }
      this.bindBuffers();
    }

    this.vertexArrayObject.bind();
    const value = func();
    this.vertexArrayObject.unbind();

    if (!this.hasVertexArrays) {
      this.unbindBuffers();
    }

    return value;
  }

  // PRIVATE

  // Resolve locations and accessors
  _resolveLocationAndAccessor(locationOrName, value, accessor1, accessor2) {
    const location = this._getAttributeIndex(locationOrName);
    if (!Number.isFinite(location)) {
      this.unused[locationOrName] = value;
      log.once(3, () => `unused value ${locationOrName} in ${this.id}`)();
      return this;
    }

    const accessInfo = this._getAttributeInfo(locationOrName, value, accessor2);

    // Override with any additional attribute configuration params
    let accessor = accessInfo ? accessInfo.accessor : new Accessor();
    accessor = accessor.getOptions(value, accessor1, accessor2);

    const {size, type} = accessor;
    assert(Number.isFinite(size) && Number.isFinite(type));

    return {location, accessor};
  }

  _getAttributeInfo(attributeName) {
    return this.configuration && this.configuration.getAttributeInfo(attributeName);
  }

  _getAttributeIndex(locationOrName) {
    if (this.configuration) {
      return this.configuration.getLocation(locationOrName);
    }
    const location = Number(locationOrName);
    if (Number.isFinite(location)) {
      return location;
    }
    return -1;
  }

  // NOTE: Desktop OpenGL cannot disable attribute 0
  // https://stackoverflow.com/questions/20305231/webgl-warning-attribute-0-is-disabled-
  // this-has-significant-performance-penalt
  _updateAttributeZeroBuffer(length = 4) {
    // Create buffer only when needed, and reuse it (avoids inflating buffer creation statistics)
    const constant = this.values[0];
    if (ArrayBuffer.isView(constant)) {
      const size = 1;
      this.buffer = this.buffer || new Buffer(this.gl, {size});
    }
  }

  // Updates all constant attribute values (constants are used when vertex attributes are disabled).
  // This needs to be done repeatedly since in contrast to buffer bindings,
  // constants are stored on the WebGL context, not the VAO
  _setConstantAttributes() {
    for (let location = 0; location < this.vertexArrayObject.MAX_ATTRIBUTES; location++) {
      const constant = this.values[location];
      if (ArrayBuffer.isView(constant)) {
        this.vertexArrayObject.enable(location, false);
        VertexArrayObject.setConstant(this.gl, location, constant);
      }
    }
  }

  // Walks the buffers and updates draw parameters
  _updateDrawParams() {
    const drawParams = {
      isIndexed: false,
      isInstanced: false,
      indexCount: Infinity,
      vertexCount: Infinity,
      instanceCount: Infinity
    };

    for (let location = 0; location < this.vertexArrayObject.MAX_ATTRIBUTES; location++) {
      this._updateDrawParamsForLocation(drawParams, location);
    }

    if (this.elements) {
      // indexing is autodetected - buffer with target GL.ELEMENT_ARRAY_BUFFER
      // index type is saved for drawElement calls
      drawParams.elementCount = this.elements.getElementCount(this.elements.accessor);
      drawParams.isIndexed = true;
      drawParams.indexType = this.elements.type;
    }

    // Post-calculation checks
    assert(Number.isFinite(drawParams.vertexCount));

    if (drawParams.indexCount === Infinity) {
      drawParams.indexCount = 0;
    }
    if (drawParams.instanceCount === Infinity) {
      drawParams.instanceCount = 0;
    }

    return drawParams;
  }

  _updateDrawParamsForLocation(drawParams, location) {
    const value = this.values[location];
    const accessor = this.accessors[location];

    if (!value) {
      return;
    }

    // Check if instanced (whether buffer or constant)
    const {divisor} = accessor;
    const isInstanced = divisor > 0;
    drawParams.isInstanced = drawParams.isInstanced || isInstanced;

    if (value instanceof Buffer) {
      const buffer = value;

      if (isInstanced) {
        // instance attribute
        const instanceCount = buffer.getVertexCount(accessor);
        drawParams.instanceCount = Math.min(drawParams.instanceCount, instanceCount);
      } else {
        // normal attribute
        const vertexCount = buffer.getVertexCount(accessor);
        drawParams.vertexCount = Math.min(drawParams.vertexCount, vertexCount);
      }
    }
  }

  // DEPRECATED

  setElements(elementBuffer = null, accessor = {}) {
    log.deprecated('setElements', 'setElementBuffer');
    return this.setElementBuffer(elementBuffer, accessor);
  }
}

// DEBUG FUNCTIONS

export function getDebugTableForVertexArray({vertexArray, header = 'Attributes'} = {}) {
  if (!vertexArray.configuration) {
    return {};
  }

  const table = {}; // {[header]: {}};

  // Add index (elements) if available
  if (vertexArray.elements) {
    // const elements = Object.assign({size: 1}, vertexArray.elements);
    table.ELEMENT_ARRAY_BUFFER =
      getDebugTableRow(vertexArray, vertexArray.elements, null, header);
  }

  // Add used attributes
  const attributes = vertexArray.values;

  for (const attributeName in attributes) {
    const info = vertexArray._getAttributeInfo(attributeName);
    if (info) {
      let rowHeader = `${attributeName}: ${info.name}`;
      const accessor = vertexArray.accessors[info.location];
      if (accessor) {
        const typeAndName = getCompositeGLType(accessor.type, accessor.size);
        if (typeAndName) { // eslint-disable-line
          rowHeader = `${attributeName}: ${info.name} (${typeAndName.name})`;
        }
      }
      table[rowHeader] =
        getDebugTableRow(vertexArray, attributes[attributeName], accessor, header);
    }
  }

  return table;
}

/* eslint-disable max-statements */
function getDebugTableRow(vertexArray, attribute, accessor, header) {
  // const round = xnum => Math.round(num * 10) / 10;
  const {gl} = vertexArray;

  let type = 'NOT PROVIDED';
  let size = 'N/A';
  let verts = 'N/A';
  let bytes = 'N/A';

  let isInteger;
  let marker;
  let value;

  if (accessor) {
    type = accessor.type;
    size = accessor.size;

    // Generate a type name by dropping Array from Float32Array etc.
    type = String(type).replace('Array', '');

    // Look for 'nt' to detect integer types, e.g. Int32Array, Uint32Array
    isInteger = type.indexOf('nt') !== -1;
  }

  if (attribute instanceof Buffer) {
    const buffer = attribute;

    const {data, modified} = buffer.getDebugData();
    marker = modified ? '*' : '';

    value = data;
    bytes = buffer.bytes;
    verts = bytes / data.BYTES_PER_ELEMENT / size;

    let format;

    if (accessor) {
      const instanced = accessor.divisor > 0;
      format = `${instanced ? 'I ' : 'P '} ${verts} (x${size}=${bytes} bytes ${glKey(gl, type)})`;
    } else {
      // element buffer
      isInteger = true;
      format = `${bytes} bytes`;
    }

    return {
      [header]: `${marker}${formatValue(value, {size, isInteger})}`,
      'Format ': format
    };
  }

  // CONSTANT VALUE
  value = attribute;
  size = attribute.length;
  // Generate a type name by dropping Array from Float32Array etc.
  type = String(attribute.constructor.name).replace('Array', '');
  // Look for 'nt' to detect integer types, e.g. Int32Array, Uint32Array
  isInteger = type.indexOf('nt') !== -1;

  return {
    [header]: `${formatValue(value, {size, isInteger})} (constant)`,
    'Format ': `${size}x${type} (constant)`
  };

}
/* eslint-ensable max-statements */