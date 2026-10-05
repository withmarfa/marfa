use std::io::{self, BufRead, Read};

/// Far past any event the server sends, which carries one row: a line
/// longer than this is not an event, and holding it would take memory
/// without end.
pub const LINE_MOST: u64 = 64 * 1024 * 1024;

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
            let read = (&mut self.reader)
                .take(LINE_MOST + 1)
                .read_line(&mut self.line)?;
            if read as u64 > LINE_MOST {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("the event stream sent a line longer than {LINE_MOST} bytes"),
                ));
            }
            let line = self.line.trim_end_matches(['\n', '\r']);
            if read == 0 || line.is_empty() {
                // A frame with no data is no event, whatever else it names.
                if !data.is_empty() {
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
                // Stored as the cursor, which a catch-up starts from: one
                // that is not an event id would be refused by every start.
                "id" if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!(
                            "the event stream named {value:?} as an event id, which is not one"
                        ),
                    ));
                }
                "id" => id = Some(value.to_string()),
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
                    event: stream_cursor\ndata: {\"event_type\":\"stream_cursor\",\"cursor\":\"42\"}\n\n\
                    id: 41\nevent: item.created\ndata: {\"event_type\":\"item.created\"}\n\n\
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
                    data: "{\"event_type\":\"stream_cursor\",\"cursor\":\"42\"}".into(),
                },
                Frame::Event {
                    id: Some("41".into()),
                    name: Some("item.created".into()),
                    data: "{\"event_type\":\"item.created\"}".into(),
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
        let text = "event: catchup_too_old\r\ndata: {\"event_type\":\"catchup_too_old\"}\r\n\r\n\
                    event: stream_incomplete\ndata: {\"reason\":\"replay_failed\"}";
        assert_eq!(
            frames(text),
            vec![
                Frame::Event {
                    id: None,
                    name: Some("catchup_too_old".into()),
                    data: "{\"event_type\":\"catchup_too_old\"}".into(),
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
    fn a_frame_with_no_data_is_no_event() {
        assert_eq!(
            frames("id: 5\n\nevent: item.created\n\n: ping\n\n"),
            vec![Frame::Comment("ping".into())]
        );
    }

    #[test]
    fn refuses_an_event_id_that_is_not_one() {
        for id in ["abc", "", "4 2", "-1"] {
            let refused = Frames::new(format!("id: {id}\ndata: {{}}\n\n").as_bytes())
                .next_frame()
                .unwrap_err();
            assert_eq!(refused.kind(), io::ErrorKind::InvalidData, "{id:?}");
        }
    }

    #[test]
    fn refuses_a_line_past_the_bound_without_holding_it_whole() {
        struct Endless;
        impl Read for Endless {
            fn read(&mut self, into: &mut [u8]) -> io::Result<usize> {
                into.fill(b'a');
                Ok(into.len())
            }
        }
        let mut frames = Frames::new(io::BufReader::new(Endless));
        let refused = frames.next_frame().unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::InvalidData);
        assert!(frames.line.len() as u64 <= LINE_MOST + 1);
    }

    #[test]
    fn an_empty_stream_yields_nothing() {
        assert!(frames("").is_empty());
        assert!(frames("\n\n\n").is_empty());
    }
}
