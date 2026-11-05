//! Turning a screenshot or share image into the small JPEG the Home screen shows.

use base64::Engine as _;
use image::imageops::FilterType;
use image::{DynamicImage, ImageReader};
use std::io::Cursor;

/// Previews are at most this wide, in pixels
pub const MAX_WIDTH: u32 = 800;
const JPEG_QUALITY: u8 = 82;
/// Larger images aren't decoded: a share image is a few hundred kilobytes, and
/// these keep a broken or hostile file from taking all the memory
const MAX_SIDE: u32 = 8192;
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
/// Share image files bigger than this aren't read at all
pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;

/// The size an image of `width` × `height` is shown at: at most `MAX_WIDTH`
/// wide, the same shape, never enlarged
pub fn fitted_size(width: u32, height: u32) -> (u32, u32) {
    if width <= MAX_WIDTH {
        return (width, height);
    }
    let fitted_height = (u64::from(height) * u64::from(MAX_WIDTH) / u64::from(width)).max(1);
    (MAX_WIDTH, fitted_height as u32)
}

/// Decodes an image (PNG, JPEG or WebP, whatever its file name says) and
/// returns it as a JPEG at most `MAX_WIDTH` wide
pub fn thumbnail_jpeg(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|e| format!("Couldn't read the image: {e}"))?;
    encode(&image)
}

/// The image as a JPEG at most `MAX_WIDTH` wide
pub fn encode(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let (width, height) = fitted_size(image.width(), image.height());
    let resized;
    let image = if width == image.width() {
        image
    } else {
        resized = image.resize_exact(width, height, FilterType::CatmullRom);
        &resized
    };
    let mut jpeg = Vec::new();
    let rgb = on_white(image);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
        .encode_image(&rgb)
        .map_err(|e| format!("Couldn't save the preview: {e}"))?;
    Ok(jpeg)
}

/// JPEG has no transparency: transparent parts are shown on white, as a page
/// would show them
fn on_white(image: &DynamicImage) -> image::RgbImage {
    if !image.color().has_alpha() {
        return image.to_rgb8();
    }
    let rgba = image.to_rgba8();
    image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let blend =
            |c: u8| ((u16::from(c) * u16::from(a) + 255 * (255 - u16::from(a)) + 127) / 255) as u8;
        image::Rgb([blend(r), blend(g), blend(b)])
    })
}

/// A `data:` URL for a JPEG
pub fn data_url(jpeg: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(jpeg);
    format!("data:image/jpeg;base64,{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, RgbaImage};

    fn image_bytes(width: u32, height: u32, format: ImageFormat) -> Vec<u8> {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            width,
            height,
            image::Rgba([200, 40, 40, 255]),
        ));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).unwrap();
        bytes.into_inner()
    }

    fn size_of(jpeg: &[u8]) -> (u32, u32) {
        let image = image::load_from_memory_with_format(jpeg, ImageFormat::Jpeg).unwrap();
        (image.width(), image.height())
    }

    #[test]
    fn fits_wide_images_to_800_keeping_the_shape() {
        assert_eq!(fitted_size(1600, 1000), (800, 500));
        assert_eq!(fitted_size(2880, 1800), (800, 500));
        assert_eq!(fitted_size(1200, 630), (800, 420));
        assert_eq!(fitted_size(801, 1), (800, 1));
    }

    #[test]
    fn never_enlarges() {
        assert_eq!(fitted_size(800, 600), (800, 600));
        assert_eq!(fitted_size(400, 300), (400, 300));
    }

    #[test]
    fn makes_a_jpeg_from_png_jpeg_and_webp() {
        for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::WebP] {
            let jpeg = thumbnail_jpeg(&image_bytes(1600, 1000, format)).unwrap();
            assert_eq!(size_of(&jpeg), (800, 500), "{format:?}");
        }
        let small = thumbnail_jpeg(&image_bytes(400, 300, ImageFormat::Png)).unwrap();
        assert_eq!(size_of(&small), (400, 300));
    }

    #[test]
    fn refuses_images_too_large_to_decode_safely() {
        assert!(thumbnail_jpeg(&image_bytes(8193, 1, ImageFormat::Png)).is_err());
        assert!(thumbnail_jpeg(&image_bytes(1, 8193, ImageFormat::Png)).is_err());
        assert!(thumbnail_jpeg(&image_bytes(8192, 1, ImageFormat::Png)).is_ok());
    }

    #[test]
    fn puts_transparent_images_on_white() {
        let clear =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(40, 20, image::Rgba([0, 0, 0, 0])));
        let mut bytes = Cursor::new(Vec::new());
        clear.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let jpeg = thumbnail_jpeg(&bytes.into_inner()).unwrap();
        let pixel = image::load_from_memory(&jpeg)
            .unwrap()
            .to_rgb8()
            .get_pixel(20, 10)
            .0;
        assert!(pixel.iter().all(|&c| c > 245), "{pixel:?}");

        let half =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(40, 20, image::Rgba([0, 0, 0, 128])));
        let mut bytes = Cursor::new(Vec::new());
        half.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let jpeg = thumbnail_jpeg(&bytes.into_inner()).unwrap();
        let pixel = image::load_from_memory(&jpeg)
            .unwrap()
            .to_rgb8()
            .get_pixel(20, 10)
            .0;
        assert!(pixel.iter().all(|&c| (115..=140).contains(&c)), "{pixel:?}");
    }

    #[test]
    fn refuses_what_isnt_an_image() {
        assert!(thumbnail_jpeg(b"not an image").is_err());
        assert!(thumbnail_jpeg(&[]).is_err());
    }

    #[test]
    fn data_urls_are_base64_jpegs() {
        assert_eq!(data_url(&[0xff, 0xd8, 0xff]), "data:image/jpeg;base64,/9j/");
    }
}
