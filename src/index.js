// @flow

'use strict';

const React = require('react');
const PropTypes = require('prop-types');
// qr.js doesn't handle error level of zero (M) so we need to do it right,
// thus the deep require.
const QRCodeImpl = require('qr.js/lib/QRCode');
const ErrorCorrectLevel = require('qr.js/lib/ErrorCorrectLevel');

// TODO: pull this off of the QRCode class type so it matches.
type Modules = Array<Array<boolean>>;
type Excavation = {|x: number, y: number, w: number, h: number|};

// Convert from UTF-16, forcing the use of byte-mode encoding in our QR Code.
// This allows us to encode Hanji, Kanji, emoji, etc. Ideally we'd do more
// detection and not resort to byte-mode if possible, but we're trading off
// a smaller library for a smaller amount of data we can potentially encode.
// Based on http://jonisalonen.com/2012/from-utf-16-to-utf-8-in-javascript/
function convertStr(str: string): string {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    let charcode = str.charCodeAt(i);
    if (charcode < 0x0080) {
      out += String.fromCharCode(charcode);
    } else if (charcode < 0x0800) {
      out += String.fromCharCode(0xc0 | (charcode >> 6));
      out += String.fromCharCode(0x80 | (charcode & 0x3f));
    } else if (charcode < 0xd800 || charcode >= 0xe000) {
      out += String.fromCharCode(0xe0 | (charcode >> 12));
      out += String.fromCharCode(0x80 | ((charcode >> 6) & 0x3f));
      out += String.fromCharCode(0x80 | (charcode & 0x3f));
    } else {
      // This is a surrogate pair, so we'll reconsitute the pieces and work
      // from that
      i++;
      charcode =
        0x10000 + (((charcode & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      out += String.fromCharCode(0xf0 | (charcode >> 18));
      out += String.fromCharCode(0x80 | ((charcode >> 12) & 0x3f));
      out += String.fromCharCode(0x80 | ((charcode >> 6) & 0x3f));
      out += String.fromCharCode(0x80 | (charcode & 0x3f));
    }
  }
  return out;
}

type QRProps = {
  value: string,
  size: number,
  level: $Keys<typeof ErrorCorrectLevel>,
  bgColor: string,
  fgColor: string,
  style?: ?Object,
  includeMargin: boolean,
  imageSettings?: {
    src: string,
    height: number,
    width: number,
    excavate: boolean,
    x?: number,
    y?: number,
  },
};

const DEFAULT_PROPS = {
  size: 128,
  level: 'L',
  bgColor: '#FFFFFF',
  fgColor: '#000000',
  includeMargin: false,
};

const PROP_TYPES =
  process.env.NODE_ENV !== 'production'
    ? {
        value: PropTypes.string.isRequired,
        size: PropTypes.number,
        level: PropTypes.oneOf(['L', 'M', 'Q', 'H']),
        bgColor: PropTypes.string,
        fgColor: PropTypes.string,
        includeMargin: PropTypes.bool,
        imageSettings: PropTypes.shape({
          src: PropTypes.string.isRequired,
          height: PropTypes.number.isRequired,
          width: PropTypes.number.isRequired,
          excavate: PropTypes.bool,
          x: PropTypes.number,
          y: PropTypes.number,
        }),
      }
    : {};

const MARGIN_SIZE = 4;

// This is *very* rough estimate of max amount of QRCode allowed to be covered.
// It is "wrong" in a lot of ways (area is a terrible way to estimate, it
// really should be number of modules covered), but if for some reason we don't
// get an explicit height or width, I'd rather default to something than throw.
const DEFAULT_IMG_SCALE = 0.1;

function generatePath(modules: Modules, margin: number = 0): string {
  const ops = [];
  modules.forEach(function (row, y) {
    let start = null;
    row.forEach(function (cell, x) {
      if (!cell && start !== null) {
        // M0 0h7v1H0z injects the space with the move and drops the comma,
        // saving a char per operation
        ops.push(
          `M${start + margin} ${y + margin}h${x - start}v1H${start + margin}z`
        );
        start = null;
        return;
      }

      // end of row, clean up or skip
      if (x === row.length - 1) {
        if (!cell) {
          // We would have closed the op above already so this can only mean
          // 2+ light modules in a row.
          return;
        }
        if (start === null) {
          // Just a single dark module.
          ops.push(`M${x + margin},${y + margin} h1v1H${x + margin}z`);
        } else {
          // Otherwise finish the current line.
          ops.push(
            `M${start + margin},${y + margin} h${x + 1 - start}v1H${
              start + margin
            }z`
          );
        }
        return;
      }

      if (cell && start === null) {
        start = x;
      }
    });
  });
  return ops.join('');
}

// We could just do this in generatePath, except that we want to support
// non-Path2D canvas, so we need to keep it an explicit step.
function excavateModules(modules: Modules, excavation: Excavation): Modules {
  return modules.slice().map((row, y) => {
    if (y < excavation.y || y >= excavation.y + excavation.h) {
      return row;
    }
    return row.map((cell, x) => {
      if (x < excavation.x || x >= excavation.x + excavation.w) {
        return cell;
      }
      return false;
    });
  });
}

function getImageSettings(
  props: QRProps,
  cells: Modules
): null | {
  x: number,
  y: number,
  h: number,
  w: number,
  excavation: ?Excavation,
} {
  const {imageSettings, size, includeMargin} = props;
  if (imageSettings == null) {
    return null;
  }
  const margin = includeMargin ? MARGIN_SIZE : 0;
  const numCells = cells.length + margin * 2;
  const defaultSize = Math.floor(size * DEFAULT_IMG_SCALE);
  const scale = numCells / size;
  const w = (imageSettings.width || defaultSize) * scale;
  const h = (imageSettings.height || defaultSize) * scale;
  const x =
    imageSettings.x == null
      ? cells.length / 2 - w / 2
      : imageSettings.x * scale;
  const y =
    imageSettings.y == null
      ? cells.length / 2 - h / 2
      : imageSettings.y * scale;

  let excavation = null;
  if (imageSettings.excavate) {
    let floorX = Math.floor(x);
    let floorY = Math.floor(y);
    let ceilW = Math.ceil(w + x - floorX);
    let ceilH = Math.ceil(h + y - floorY);
    excavation = {x: floorX, y: floorY, w: ceilW, h: ceilH};
  }

  return {x, y, h, w, excavation};
}

// For canvas we're going to switch our drawing mode based on whether or not
// the environment supports Path2D. We only need the constructor to be
// supported, but Edge doesn't actually support the path (string) type
// argument. Luckily it also doesn't support the addPath() method. We can
// treat that as the same thing.
const SUPPORTS_PATH2D = (function () {
  try {
    new Path2D().addPath(new Path2D());
  } catch (e) {
    return false;
  }
  return true;
})();

class QRCodeCanvas extends React.PureComponent<QRProps, {imgLoaded: boolean}> {
  _canvas: ?HTMLCanvasElement;
  _image: ?HTMLImageElement;

  state = {imgLoaded: false};

  static defaultProps = DEFAULT_PROPS;

  componentDidMount() {
    if (this._image && this._image.complete) {
      this.handleImageLoad();
    }

    this.update();
  }

  componentWillReceiveProps(nextProps) {
    const currentSrc = this.props.imageSettings?.src;
    const nextSrc = nextProps.imageSettings?.src;
    if (currentSrc !== nextSrc) {
      this.setState({imgLoaded: false});
    }
  }

  componentDidUpdate() {
    this.update();
  }

  update() {
    const {value, size, level, bgColor, fgColor, includeMargin, imageSettings} =
      this.props;

    // We'll use type===-1 to force QRCode to automatically pick the best type
    const qrcode = new QRCodeImpl(-1, ErrorCorrectLevel[level]);
    qrcode.addData(convertStr(value));
    qrcode.make();

    if (this._canvas != null) {
      const canvas = this._canvas;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return;
      }

      let cells = qrcode.modules;
      if (cells === null) {
        return;
      }

      const margin = includeMargin ? MARGIN_SIZE : 0;
      const numCells = cells.length + margin * 2;
      const calculatedImageSettings = getImageSettings(this.props, cells);

      if (imageSettings != null && calculatedImageSettings != null) {
        if (calculatedImageSettings.excavation != null) {
          cells = excavateModules(cells, calculatedImageSettings.excavation);
        }
      }

      // We're going to scale this so that the number of drawable units
      // matches the number of cells. This avoids rounding issues, but does
      // result in some potentially unwanted single pixel issues between
      // blocks, only in environments that don't support Path2D.
      const pixelRatio = window.devicePixelRatio || 1;
      canvas.height = canvas.width = size * pixelRatio;
      const scale = (size / numCells) * pixelRatio;
      ctx.scale(scale, scale);

      // Draw solid background, only paint dark modules.
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, numCells, numCells);

      ctx.fillStyle = fgColor;
      if (SUPPORTS_PATH2D) {
        // $FlowFixMe: Path2D c'tor doesn't support args yet.
        ctx.fill(new Path2D(generatePath(cells, margin)));
      } else {
        cells.forEach(function (row, rdx) {
          row.forEach(function (cell, cdx) {
            if (cell) {
              ctx.fillRect(cdx + margin, rdx + margin, 1, 1);
            }
          });
        });
      }
      if (
        this.state.imgLoaded &&
        this._image &&
        calculatedImageSettings != null
      ) {
        ctx.drawImage(
          this._image,
          calculatedImageSettings.x + margin,
          calculatedImageSettings.y + margin,
          calculatedImageSettings.w,
          calculatedImageSettings.h
        );
      }
    }
  }

  handleImageLoad = () => {
    this.setState({imgLoaded: true});
  };

  render() {
    const {
      value,
      size,
      level,
      bgColor,
      fgColor,
      style,
      includeMargin,
      imageSettings,
      ...otherProps
    } = this.props;
    const canvasStyle = {height: size, width: size, ...style};
    let img = null;
    let imgSrc = imageSettings && imageSettings.src;
    if (imageSettings != null && imgSrc != null) {
      img = (
        <img
          src={imgSrc}
          style={{display: 'none'}}
          onLoad={this.handleImageLoad}
          ref={(ref: ?HTMLImageElement): ?HTMLImageElement =>
            (this._image = ref)
          }
        />
      );
    }
    return (
      <>
        <canvas
          style={canvasStyle}
          height={size}
          width={size}
          ref={(ref: ?HTMLCanvasElement): ?HTMLCanvasElement =>
            (this._canvas = ref)
          }
          {...otherProps}
        />
        {img}
      </>
    );
  }
}

if (process.env.NODE_ENV !== 'production') {
  QRCodeCanvas.propTypes = PROP_TYPES;
}

class QRCodeSVG extends React.PureComponent<QRProps> {
  static defaultProps = DEFAULT_PROPS;

  render() {
    const {
      value,
      size,
      level,
      bgColor,
      fgColor,
      includeMargin,
      imageSettings,
      ...otherProps
    } = this.props;

    // We'll use type===-1 to force QRCode to automatically pick the best type
    const qrcode = new QRCodeImpl(-1, ErrorCorrectLevel[level]);
    qrcode.addData(convertStr(value));
    qrcode.make();

    let cells = qrcode.modules;
    if (cells === null) {
      return null;
    }

    const margin = includeMargin ? MARGIN_SIZE : 0;
    const numCells = cells.length + margin * 2;
    const calculatedImageSettings = getImageSettings(this.props, cells);

    let image = null;
    if (imageSettings != null && calculatedImageSettings != null) {
      if (calculatedImageSettings.excavation != null) {
        cells = excavateModules(cells, calculatedImageSettings.excavation);
      }

      image = (
        <image
          xlinkHref={imageSettings.src}
          height={calculatedImageSettings.h}
          width={calculatedImageSettings.w}
          x={calculatedImageSettings.x + margin}
          y={calculatedImageSettings.y + margin}
          preserveAspectRatio="none"
        />
      );
    }

    // Drawing strategy: instead of a rect per module, we're going to create a
    // single path for the dark modules and layer that on top of a light rect,
    // for a total of 2 DOM nodes. We pay a bit more in string concat but that's
    // way faster than DOM ops.
    // For level 1, 441 nodes -> 2
    // For level 40, 31329 -> 2
    const fgPath = generatePath(cells, margin);

    return (
      <svg
        shapeRendering="crispEdges"
        height={size}
        width={size}
        viewBox={`0 0 ${numCells} ${numCells}`}
        {...otherProps}>
        <path fill={bgColor} d={`M0,0 h${numCells}v${numCells}H0z`} />
        <path fill={fgColor} d={fgPath} />
        {image}
      </svg>
    );
  }
}

if (process.env.NODE_ENV !== 'production') {
  QRCodeSVG.propTypes = PROP_TYPES;
}

type RootProps = QRProps & {renderAs: 'svg' | 'canvas'};
const QRCode = (props: RootProps): React.Node => {
  const {renderAs, ...otherProps} = props;
  const Component = renderAs === 'svg' ? QRCodeSVG : QRCodeCanvas;
  return <Component {...otherProps} />;
};

QRCode.defaultProps = {renderAs: 'canvas', ...DEFAULT_PROPS};

module.exports = QRCode;
