use std::io::{self, BufRead};

/// One block of a `text/event-stream`: a named event with its data, or a
/// comment such as the server's `:ping`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Comment(String),
    Event {
        id: Option<String>,
        name: Option<String>,
        data: String,
    },
}

pub struct Frames<R: BufRead> {
    reader: R,
    line: String,
}

impl<R: BufRead> Frames<R> {
    pub fn new(reader: R) -> Frames<R> {
        Frames {
            reader,
            line: String::new(),
        }
    }

    pub fn next_frame(&mut self) -> io::Result<Option<Frame>> {
        let mut id = None;
        let mut name = None;
        let mut data: Vec<String> = Vec::new();
        let mut comment: Option<String> = None;
        loop {
            self.line.clear();
            let read = self.reader.read_line(&mut self.line)?;
            let line = self.line.trim_end_matches(['\n', '\r']);
            if read == 0 || line.is_empty() {
                if !data.is_empty() || name.is_some() || id.is_some() {
                    return Ok(Some(Frame::Event {
                        id,
                        name,
                        data: data.join("\n"),
                    }));
                }
                if let Some(text) = comment.take() {
                    return Ok(Some(Frame::Comment(text)));
                }
                if read == 0 {
                    return Ok(None);
                }
                continue;
            }
            if let Some(text) = line.strip_prefix(':') {
                comment = Some(text.trim_start().to_string());
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
                None => (line, ""),
            };
            match field {
                "event" => name = Some(value.to_string()),
                "data" => data.push(value.to_string()),
                "id" if !value.contains('\0') => id = Some(value.to_string()),
                _ => {}
            }
        }
    }
}

impl<R: BufRead> Iterator for Frames<R> {
    type Item = io::Result<Frame>;

    fn next(&mut self) -> Option<Self::Item> {
        self.next_frame().transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(text: &str) -> Vec<Frame> {
        Frames::new(text.as_bytes())
            .collect::<io::Result<Vec<Frame>>>()
            .unwrap()
    }

    #[test]
    fn parses_the_prologue_a_replay_and_a_ping() {
        let text = ": connected\n\n\
                    event: stream_cursor\ndata: {\"type\":\"stream_cursor\",\"cursor\":\"42\"}\n\n\
                    id: 41\nevent: item.created\ndata: {\"type\":\"item.created\"}\n\n\
                    :ping\n\n\
                    id: 42\nevent: edge.deleted\ndata: {\"a\":1,\n\
                    data:  \"b\":2}\n\n";
        assert_eq!(
            frames(text),
            vec![
                Frame::Comment("connected".into()),
                Frame::Event {
                    id: None,
                    name: Some("stream_cursor".into()),
                    data: "{\"type\":\"stream_cursor\",\"cursor\":\"42\"}".into(),
                },
                Frame::Event {
                    id: Some("41".into()),
                    name: Some("item.created".into()),
                    data: "{\"type\":\"item.created\"}".into(),
                },
                Frame::Comment("ping".into()),
                Frame::Event {
                    id: Some("42".into()),
                    name: Some("edge.deleted".into()),
                    data: "{\"a\":1,\n \"b\":2}".into(),
                },
            ]
        );
    }

    #[test]
    fn terminal_frames_and_crlf_and_a_missing_final_blank_line() {
        let text = "id: 7\r\nevent: catchup_too_old\r\ndata: {\"type\":\"catchup_too_old\"}\r\n\r\n\
                    event: stream_incomplete\ndata: {\"reason\":\"replay_failed\"}";
        assert_eq!(
            frames(text),
            vec![
                Frame::Event {
                    id: Some("7".into()),
                    name: Some("catchup_too_old".into()),
                    data: "{\"type\":\"catchup_too_old\"}".into(),
                },
                Frame::Event {
                    id: None,
                    name: Some("stream_incomplete".into()),
                    data: "{\"reason\":\"replay_failed\"}".into(),
                },
            ]
        );
    }

    #[test]
    fn an_empty_stream_yields_nothing() {
        assert!(frames("").is_empty());
        assert!(frames("\n\n\n").is_empty());
    }
}
