//! P2P wire messages for the production core.
//!
//! A newline-delimited text protocol (mirrors the JS reference's gossip shape).
//! Kept dependency-free: encoding/decoding is hand-written and fully tested,
//! including a real TCP round-trip using `std::net`.

#[derive(Debug, Clone, PartialEq)]
pub enum Msg {
    /// announce our current chain height
    Hello(u64),
    /// request blocks starting at height N
    GetBlocks(u64),
    /// announce we have up to height N
    Have(u64),
    Ping,
    Pong,
}

impl Msg {
    pub fn encode(&self) -> String {
        match self {
            Msg::Hello(h) => format!("HELLO {h}"),
            Msg::GetBlocks(h) => format!("GETBLOCKS {h}"),
            Msg::Have(h) => format!("HAVE {h}"),
            Msg::Ping => "PING".to_string(),
            Msg::Pong => "PONG".to_string(),
        }
    }

    pub fn parse(line: &str) -> Option<Msg> {
        let mut it = line.split_whitespace();
        match it.next()? {
            "HELLO" => Some(Msg::Hello(it.next()?.parse().ok()?)),
            "GETBLOCKS" => Some(Msg::GetBlocks(it.next()?.parse().ok()?)),
            "HAVE" => Some(Msg::Have(it.next()?.parse().ok()?)),
            "PING" => Some(Msg::Ping),
            "PONG" => Some(Msg::Pong),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    #[test]
    fn roundtrip_all_variants() {
        for m in [
            Msg::Hello(42),
            Msg::GetBlocks(7),
            Msg::Have(100),
            Msg::Ping,
            Msg::Pong,
        ] {
            assert_eq!(Msg::parse(&m.encode()), Some(m));
        }
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(Msg::parse("NONSENSE 1"), None);
        assert_eq!(Msg::parse("HELLO notanumber"), None);
    }

    #[test]
    fn tcp_handshake_over_std_net() {
        // A minimal peer: read one HELLO, reply HAVE(our_height).
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (sock, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(sock.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let got = Msg::parse(line.trim());
            assert_eq!(got, Some(Msg::Hello(5)));
            let mut w = sock;
            writeln!(w, "{}", Msg::Have(9).encode()).unwrap();
        });

        // client sends HELLO(5), expects HAVE(9)
        let mut client = TcpStream::connect(addr).unwrap();
        writeln!(client, "{}", Msg::Hello(5).encode()).unwrap();
        let mut reader = BufReader::new(client);
        let mut resp = String::new();
        reader.read_line(&mut resp).unwrap();
        assert_eq!(Msg::parse(resp.trim()), Some(Msg::Have(9)));

        server.join().unwrap();
    }
}
