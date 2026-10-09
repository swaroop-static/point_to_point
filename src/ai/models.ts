/**
 * Optional click-to-segment models. Nothing here is bundled: the user picks a
 * model and downloads it on purpose (or loads their own files). Downloads go
 * from the host named below to the user's browser; the user's images are never
 * sent anywhere, inference runs locally in WebAssembly.
 *
 * Licenses were read from the model cards on 2026-10-10. Verify again before
 * redistributing weights; this app does not redistribute them.
 */

/** 'sam1': original SAM decoder interface (MobileSAM). 'hfsam': Hugging Face / transformers.js SAM interface (SlimSAM). */
export type SamFlavor = 'sam1' | 'hfsam';

export interface ModelFile { name: string; url: string; sizeMB: number }

export interface SamModelSpec {
  id: string;
  label: string;
  blurb: string;
  flavor: SamFlavor;
  encoder: ModelFile;
  decoder: ModelFile;
  license: string;
  source: string;
}

const HF = 'https://huggingface.co';

export const SAM_MODELS: SamModelSpec[] = [
  {
    id: 'slimsam-77-q',
    label: 'SlimSAM-77 (quantized)',
    blurb: 'Smallest download (about 14 MB). Fast; masks are a little rougher.',
    flavor: 'hfsam',
    encoder: { name: 'vision_encoder_quantized.onnx', url: `${HF}/Xenova/slimsam-77-uniform/resolve/main/onnx/vision_encoder_quantized.onnx`, sizeMB: 8.9 },
    decoder: { name: 'prompt_encoder_mask_decoder_quantized.onnx', url: `${HF}/Xenova/slimsam-77-uniform/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx`, sizeMB: 4.9 },
    license: 'Apache-2.0 (model card: Xenova/slimsam-77-uniform)',
    source: `${HF}/Xenova/slimsam-77-uniform`,
  },
  {
    id: 'mobilesam',
    label: 'MobileSAM',
    blurb: 'Better masks, about 45 MB download.',
    flavor: 'sam1',
    encoder: { name: 'mobile_sam_image_encoder.onnx', url: `${HF}/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx`, sizeMB: 28.2 },
    decoder: { name: 'sam_mask_decoder_single.onnx', url: `${HF}/Acly/MobileSAM/resolve/main/sam_mask_decoder_single.onnx`, sizeMB: 16.5 },
    license: 'MobileSAM code: Apache-2.0. ONNX conversion (Acly/MobileSAM): MIT per its model card. The upstream weights repo states no separate license.',
    source: `${HF}/Acly/MobileSAM`,
  },
];

export function modelById(id: string): SamModelSpec | undefined { return SAM_MODELS.find((m) => m.id === id); }
