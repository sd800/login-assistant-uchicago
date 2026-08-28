# Icon artwork

The extension uses a white phoenix holding a key on a maroon tile. Rounded corners are encoded in the PNG's transparency, so the shape remains consistent in Chrome's toolbar, extension list, and extension pages. The artwork is the same in light and dark appearances.

This is the identity of an independent project, not an official university mark. See the [independence statement](../README.md#independence-statement).

## Assets

| Asset | Size | Use |
| --- | --- | --- |
| [Square master](assets/phoenix-key-master.png) | 1254 x 1254 | Source artwork for exports |
| [Rounded master](assets/phoenix-key-rounded.png) | 1254 x 1254 | High-resolution artwork and README image |
| [16px icon](../extension/icons/icon-16.png) | 16 x 16 | Chrome toolbar |
| [32px icon](../extension/icons/icon-32.png) | 32 x 32 | Toolbar and page favicon |
| [48px icon](../extension/icons/icon-48.png) | 48 x 48 | Extension list and toolbar |
| [128px icon](../extension/icons/icon-128.png) | 128 x 128 | Extension identity and page headers |

The master artwork is raster PNG, not an editable vector. Its maroon background includes raster color variations and antialiased edges. The interface's button colors are defined separately in [ui.css](../extension/ui.css).

## Displaying the icon

Use the rounded master for larger documentation images and the packaged sizes for Chrome. Preserve the image's aspect ratio; setting a width without a conflicting height avoids distortion. The transparent corners do not need an additional CSS crop.

Larger artwork shows more feather and key detail. At toolbar sizes, the phoenix and key silhouettes carry the identity. Check the smallest export at its actual display size rather than judging it only at high zoom.

## Rebuilding exports

The exported PNGs are included in the repository. Installing the extension, running tests, and creating a release archive do not require an image-processing library.

To regenerate the files, make [Sharp](https://sharp.pixelplumbing.com/) available locally and run:

```sh
node scripts/export-icons.mjs
```

The script also accepts the path to a locally installed Sharp entry module:

```sh
node scripts/export-icons.mjs /absolute/path/to/sharp/lib/index.js
```

The [export script](../scripts/export-icons.mjs) reads the square master, applies a rounded mask with a radius of one quarter of the image width, and produces the rounded master plus four icon sizes. Resizing uses Lanczos3 sampling. The square master is left unchanged.

Before writing the exports, the script checks their dimensions, alpha channels, transparent corners, opaque centers and straight edges, and antialiased edges. It also checks that fully opaque pixels in the rounded master match the source artwork.

After an export, run the asset checks:

```sh
npm run check
```

Inspect the results in Chrome at normal and high display density, with both light and dark appearances. Confirm that the emblem is legible and that the corners are transparent rather than painted to resemble transparency.
