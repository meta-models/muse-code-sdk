#[derive(Default)]
pub(super) struct NdjsonDecoder {
    buffer: String,
}

impl NdjsonDecoder {
    pub(super) fn push(&mut self, chunk: &str) -> Vec<String> {
        if chunk.is_empty() {
            return Vec::new();
        }
        let old_len = self.buffer.len();
        self.buffer.push_str(chunk);
        let mut frames = Vec::new();
        let mut frame_start = 0;
        let mut scan_from = old_len;
        while let Some(relative_newline) = self.buffer[scan_from..].find('\n') {
            let newline = scan_from + relative_newline;
            frames.push(self.buffer[frame_start..newline].to_owned());
            frame_start = newline + 1;
            scan_from = frame_start;
        }
        if frame_start > 0 {
            self.buffer.drain(..frame_start);
        }
        frames
    }

    pub(super) fn truncated_frame_byte_len(&self) -> Option<usize> {
        (!self.buffer.trim().is_empty()).then_some(self.buffer.len())
    }
}
