//! JSON mínimo (leitura e escrita), para o motor não depender de bibliotecas externas.

#[derive(Clone, Debug)]
pub enum J {
    Null,
    Bool(bool),
    /// Valor e texto original (o id da peça volta exatamente como veio).
    Num(f64, String),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    pub fn get(&self, key: &str) -> Option<&J> {
        match self {
            J::Obj(v) => v.iter().find(|(k, _)| k == key).map(|(_, x)| x),
            _ => None,
        }
    }
    pub fn num(&self) -> Option<f64> {
        match self {
            J::Num(v, _) => Some(*v),
            _ => None,
        }
    }
    pub fn arr(&self) -> &[J] {
        match self {
            J::Arr(v) => v,
            _ => &[],
        }
    }
    pub fn entries(&self) -> &[(String, J)] {
        match self {
            J::Obj(v) => v,
            _ => &[],
        }
    }
    pub fn truthy(&self) -> bool {
        match self {
            J::Null => false,
            J::Bool(b) => *b,
            J::Num(v, _) => *v != 0.0,
            J::Str(s) => !s.is_empty(),
            J::Arr(v) => !v.is_empty(),
            J::Obj(v) => !v.is_empty(),
        }
    }
    /// Texto como o `str()` do Python faria para números e textos.
    pub fn text(&self) -> String {
        match self {
            J::Str(s) => s.clone(),
            J::Num(_, raw) => raw.clone(),
            J::Bool(b) => (if *b { "True" } else { "False" }).to_string(),
            _ => String::new(),
        }
    }
    /// O valor de volta em JSON (usado para devolver o id da peça).
    pub fn raw(&self) -> String {
        match self {
            J::Num(_, raw) => raw.clone(),
            J::Str(s) => quote(s),
            J::Bool(b) => b.to_string(),
            _ => "null".to_string(),
        }
    }
}

pub fn quote(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

pub fn parse(text: &str) -> Result<J, String> {
    let mut p = Parser { b: text.as_bytes(), i: 0 };
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return Err(format!("texto sobrando na posição {}", p.i));
    }
    Ok(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\n' | b'\r' | b'\t') {
            self.i += 1;
        }
    }
    fn lit(&mut self, word: &str, v: J) -> Result<J, String> {
        if self.b[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(format!("valor inválido na posição {}", self.i))
        }
    }
    fn value(&mut self) -> Result<J, String> {
        self.ws();
        match self.b.get(self.i) {
            None => Err("fim inesperado".to_string()),
            Some(b'{') => {
                self.i += 1;
                let mut out = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(J::Obj(out));
                }
                loop {
                    self.ws();
                    let k = self.string()?;
                    self.ws();
                    if self.b.get(self.i) != Some(&b':') {
                        return Err(format!("faltou ':' na posição {}", self.i));
                    }
                    self.i += 1;
                    let v = self.value()?;
                    out.push((k, v));
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(J::Obj(out));
                        }
                        _ => return Err(format!("objeto mal formado na posição {}", self.i)),
                    }
                }
            }
            Some(b'[') => {
                self.i += 1;
                let mut out = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(J::Arr(out));
                }
                loop {
                    out.push(self.value()?);
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(J::Arr(out));
                        }
                        _ => return Err(format!("lista mal formada na posição {}", self.i)),
                    }
                }
            }
            Some(b'"') => Ok(J::Str(self.string()?)),
            Some(b't') => self.lit("true", J::Bool(true)),
            Some(b'f') => self.lit("false", J::Bool(false)),
            Some(b'n') => self.lit("null", J::Null),
            Some(_) => {
                let s = self.i;
                while self.i < self.b.len() && matches!(self.b[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                    self.i += 1;
                }
                let raw = std::str::from_utf8(&self.b[s..self.i]).unwrap_or("");
                raw.parse::<f64>().map(|v| J::Num(v, raw.to_string())).map_err(|_| format!("número inválido na posição {}", s))
            }
        }
    }
    fn hex4(&mut self) -> Result<u32, String> {
        let h = self.b.get(self.i..self.i + 4).ok_or("escape \\u incompleto")?;
        self.i += 4;
        u32::from_str_radix(std::str::from_utf8(h).map_err(|_| "escape \\u inválido")?, 16).map_err(|_| "escape \\u inválido".to_string())
    }
    fn string(&mut self) -> Result<String, String> {
        if self.b.get(self.i) != Some(&b'"') {
            return Err(format!("esperava texto na posição {}", self.i));
        }
        self.i += 1;
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = *self.b.get(self.i).ok_or("texto sem fim")?;
            self.i += 1;
            match c {
                b'"' => break,
                b'\\' => {
                    let e = *self.b.get(self.i).ok_or("escape sem fim")?;
                    self.i += 1;
                    match e {
                        b'n' => out.push(b'\n'),
                        b't' => out.push(b'\t'),
                        b'r' => out.push(b'\r'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'u' => {
                            let mut cp = self.hex4()?;
                            if (0xD800..0xDC00).contains(&cp) && self.b.get(self.i..self.i + 2) == Some(b"\\u") {
                                self.i += 2;
                                let lo = self.hex4()?;
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo.wrapping_sub(0xDC00) & 0x3FF);
                            }
                            let ch = char::from_u32(cp).unwrap_or('\u{FFFD}');
                            let mut buf = [0u8; 4];
                            out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                        }
                        other => out.push(other),
                    }
                }
                c => out.push(c),
            }
        }
        String::from_utf8(out).map_err(|_| "texto não é UTF-8".to_string())
    }
}
