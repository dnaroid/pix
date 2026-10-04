use tauri::{image::JsImage, ResourceTable};

// A 1x1 red PNG, matching the encoded-byte payload passed by writeImage in JS.
const RED_PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0,
    5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

#[test]
fn clipboard_png_payload_decodes_to_rgba() {
    let payload: JsImage = serde_json::from_value(serde_json::json!(RED_PNG)).unwrap();
    // This is the real conversion used by tauri-plugin-clipboard-manager,
    // without touching the user's pasteboard or mocking native image decoding.
    let resources = ResourceTable::default();
    let image = payload.into_img(&resources).unwrap();
    assert_eq!((image.width(), image.height()), (1, 1));
    assert_eq!(image.rgba(), &[255, 0, 0, 255]);
}

#[test]
fn clipboard_rejects_invalid_encoded_image() {
    let payload: JsImage = serde_json::from_value(serde_json::json!([1, 2, 3])).unwrap();
    assert!(payload.into_img(&ResourceTable::default()).is_err());
}
