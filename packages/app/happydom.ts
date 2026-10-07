import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { mock } from "bun:test"

// Bun resolves `solid-js/web` to the server build (dist/server.js) which lacks
// the `use` export that Solid components need in test environments. Redirect
// to the client build before any component import triggers the resolution.
mock.module("solid-js/web", () => {
  // The client build (web.js) has `use`/`render` but lacks `isServer` and
  // `delegateEvents` which the server build (server.js) provides. Merge both,
  // with the client build winning for overlapping exports.
  const server = require("solid-js/web/dist/server.js")
  const client = require("solid-js/web/dist/web.js")
  return Object.assign({}, server, client)
})

GlobalRegistrator.register()

const originalGetContext = HTMLCanvasElement.prototype.getContext
// @ts-expect-error - we're overriding with a simplified mock
HTMLCanvasElement.prototype.getContext = function (contextType: string, _options?: unknown) {
  if (contextType === "2d") {
    return {
      canvas: this,
      fillStyle: "#000000",
      strokeStyle: "#000000",
      font: "12px monospace",
      textAlign: "start",
      textBaseline: "alphabetic",
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      imageSmoothingEnabled: true,
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      miterLimit: 10,
      shadowBlur: 0,
      shadowColor: "rgba(0, 0, 0, 0)",
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      fillRect: () => {},
      strokeRect: () => {},
      clearRect: () => {},
      fillText: () => {},
      strokeText: () => {},
      measureText: (text: string) => ({ width: text.length * 8 }),
      drawImage: () => {},
      save: () => {},
      restore: () => {},
      scale: () => {},
      rotate: () => {},
      translate: () => {},
      transform: () => {},
      setTransform: () => {},
      resetTransform: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createPattern: () => null,
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      bezierCurveTo: () => {},
      quadraticCurveTo: () => {},
      arc: () => {},
      arcTo: () => {},
      ellipse: () => {},
      rect: () => {},
      fill: () => {},
      stroke: () => {},
      clip: () => {},
      isPointInPath: () => false,
      isPointInStroke: () => false,
      getTransform: () => ({}),
      getImageData: () => ({
        data: new Uint8ClampedArray(0),
        width: 0,
        height: 0,
      }),
      putImageData: () => {},
      createImageData: () => ({
        data: new Uint8ClampedArray(0),
        width: 0,
        height: 0,
      }),
    } as unknown as CanvasRenderingContext2D
  }
  return originalGetContext.call(this, contextType as "2d", _options)
}
