//! The product's non-Unicode JavaScript RegExp wildcard grammar. `?` consumes
//! one UTF-16 unit, including half a supplementary character; Unicode-scalar
//! regexes can miss configured deny rules on otherwise valid file names.
use crate::protocol::Error;
use regex::bytes::{Regex, RegexBuilder};

#[derive(Clone)]
pub(crate) struct Wildcard {
    expression: Regex,
    insensitive: bool,
}

impl Wildcard {
    pub(crate) fn compile(pattern: &str) -> Result<Self, Error> {
        Self::new(pattern, cfg!(windows))
    }

    fn new(pattern: &str, insensitive: bool) -> Result<Self, Error> {
        let normalized = pattern.replace('\\', "/");
        let optional_args = normalized.ends_with(" *");
        let prefix = if optional_args {
            &normalized[..normalized.len() - 2]
        } else {
            &normalized
        };
        let mut expression = String::from(r"\A");
        for unit in prefix.encode_utf16() {
            match unit {
                42 => expression.push_str("(?:..)*"),
                63 => expression.push_str("(?:..)"),
                unit => {
                    for byte in canonicalize(unit, insensitive).to_le_bytes() {
                        expression.push_str(&format!(r"\x{byte:02x}"));
                    }
                }
            }
        }
        if optional_args {
            expression.push_str(r"(?:\x20\x00(?:..)*)?");
        }
        expression.push_str(r"\z");
        Ok(Self {
            // Every token consumes an integral number of little-endian UTF-16
            // units. Byte regexes therefore cannot shift a wildcard off a unit
            // boundary, even when matching a surrogate pair partially.
            expression: RegexBuilder::new(&expression)
                .unicode(false)
                .dot_matches_new_line(true)
                .build()
                .map_err(|_| Error::Invalid("invalid agent wildcard".into()))?,
            insensitive,
        })
    }

    pub(crate) fn is_match(&self, input: &str) -> bool {
        self.expression.is_match(
            &input
                .replace('\\', "/")
                .encode_utf16()
                .flat_map(|unit| canonicalize(unit, self.insensitive).to_le_bytes())
                .collect::<Vec<_>>(),
        )
    }
}

fn canonicalize(unit: u16, insensitive: bool) -> u16 {
    if !insensitive {
        return unit;
    }
    let Some(character) = char::from_u32(u32::from(unit)) else {
        return unit;
    };
    let mut uppercase = character.to_uppercase();
    let upper = uppercase.next().expect("uppercase is nonempty");
    // JavaScript's non-Unicode ignoreCase canonicalization works on single
    // UTF-16 units, ignores expanding uppercase mappings and prevents a
    // non-ASCII unit from folding into ASCII (e.g. long s into S).
    if uppercase.next().is_some() || upper.len_utf16() != 1 || (unit >= 128 && upper.is_ascii()) {
        return unit;
    }
    upper as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_boundaries_literals_and_optional_arguments_match_the_product() {
        for (pattern, input, expected) in [
            ("?.txt", "😀.txt", false),
            ("??.txt", "😀.txt", true),
            ("*?.txt", "😀.txt", true),
            ("??.txt", "中.txt", false),
            ("😀.txt", "😀.txt", true),
            ("😀.txt", "😁.txt", false),
            ("echo ?? *", "echo 😀", true),
            ("echo ?? *", "echo 😀 --flag", true),
            ("echo ?? *", "echo 😀-suffix", false),
            ("nested\\??.txt", "nested/😀.txt", true),
            ("a?b", "a\nb", true),
            ("literal[1].txt", "literal1.txt", false),
            ("literal[1].txt", "literal[1].txt", true),
            ("", "", true),
        ] {
            for insensitive in [false, true] {
                assert_eq!(
                    Wildcard::new(pattern, insensitive).unwrap().is_match(input),
                    expected,
                    "{pattern:?} / {input:?}"
                );
            }
        }
    }

    #[test]
    fn windows_case_folding_uses_non_unicode_javascript_canonicalization() {
        for (pattern, input, expected) in [
            ("ABC", "abc", true),
            ("Σ", "ς", true),
            ("É", "é", true),
            ("S", "ſ", false),
            ("K", "K", false),
            ("SS", "ß", false),
            ("𐐀", "𐐨", false),
        ] {
            assert_eq!(
                Wildcard::new(pattern, true).unwrap().is_match(input),
                expected,
                "{pattern:?} / {input:?}"
            );
            assert!(!Wildcard::new(pattern, false).unwrap().is_match(input));
        }
    }
}
