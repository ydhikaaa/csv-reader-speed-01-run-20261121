// A CSV reader with csv-reader 1.0.0's exact reading policy, written for speed.
//
// The policy, matched answer for answer: a leading U+FEFF is dropped; records end at LF or CRLF and a
// line with no characters is no record; a CR outside quotes that is not part of a CRLF is dropped
// (stray_cr); a field that opens with a quote runs to the next undoubled quote, "" inside it is one
// quote, and every CRLF or lone CR inside it reads as one LF; text after a closing quote, up to the
// next comma or line break, is appended as it stands (quote_junk when anything was appended); a quote
// that never closes is a literal character and the rest of the field is read again as unquoted
// (unterminated_quote); quotes inside unquoted fields are literal; fields stay strings. The first
// record is the columns when header is true (columns is null otherwise) and sets the width every later
// record is padded to (short_row) or cut to (long_row). Errors are {code, line, row} in the order met.
//
// Where the speed comes from: field scanning is two-tiered. The first SCAN_SPAN characters of a field
// are walked by a tight charCodeAt loop — at the short lengths most fields have, that beats any native
// call's setup cost, and the value is cut out with one String.slice. A field still unterminated after
// that span is long, and long fields are where native scanning wins by an order of magnitude, so the
// scan hands over to indexOf: the next comma/LF (unquoted) or the closing quote (quoted) is found
// natively, the slice between is the value, and a native indexOf over the slice settles whether a CR
// hides in it. Only the rare shapes — a stray CR inside an unquoted field, doubled quotes or CRs
// inside a quoted one, an unterminated quote — fall through to the slow readers, which assemble
// values from slice segments exactly as the policy demands. Nothing is kept between calls: all state
// lives inside run().

const COMMA_END = 0;
const BREAK_END = 1;
const TEXT_END = 2;
const SCAN_SPAN = 64; // characters walked in JS before native scanning takes over a field

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // index of the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1; // the line the record being read starts on
  let recordRow = null; // its index in rows (null: the header)

  // The field readers report through these channels instead of returning objects.
  let fVal = ''; // the field just read
  let fEnd = TEXT_END; // how it ended
  let uAdded = 0; // characters an unquoted read kept (drives quote_junk)

  // The slow unquoted reader: walks characters, drops stray CRs (one stray_cr error each) and
  // assembles the value from the slices between them. Sets fVal, fEnd and uAdded.
  function readUnquotedSlow(init) {
    const start = pos;
    let i = pos;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 44) {
        fVal = init === '' ? text.slice(start, i) : init + text.slice(start, i);
        uAdded = i - start;
        pos = i + 1;
        fEnd = COMMA_END;
        return;
      }
      if (c === 10) {
        fVal = init === '' ? text.slice(start, i) : init + text.slice(start, i);
        uAdded = i - start;
        pos = i + 1;
        line += 1;
        fEnd = BREAK_END;
        return;
      }
      if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) {
          fVal = init === '' ? text.slice(start, i) : init + text.slice(start, i);
          uAdded = i - start;
          pos = i + 2;
          line += 1;
          fEnd = BREAK_END;
          return;
        }
        // A stray CR: the value is assembled from the slices between dropped CRs.
        const parts = init === '' ? [] : [init];
        if (i > start) parts.push(text.slice(start, i));
        let added = i - start;
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        i += 1;
        let seg = i;
        for (;;) {
          if (i >= len) {
            if (i > seg) {
              parts.push(text.slice(seg, i));
              added += i - seg;
            }
            fVal = parts.join('');
            uAdded = added;
            pos = len;
            fEnd = TEXT_END;
            return;
          }
          const d = text.charCodeAt(i);
          if (d === 44 || d === 10) {
            if (i > seg) {
              parts.push(text.slice(seg, i));
              added += i - seg;
            }
            fVal = parts.join('');
            uAdded = added;
            pos = i + 1;
            if (d === 10) {
              line += 1;
              fEnd = BREAK_END;
            } else {
              fEnd = COMMA_END;
            }
            return;
          }
          if (d === 13) {
            if (text.charCodeAt(i + 1) === 10) {
              if (i > seg) {
                parts.push(text.slice(seg, i));
                added += i - seg;
              }
              fVal = parts.join('');
              uAdded = added;
              pos = i + 2;
              line += 1;
              fEnd = BREAK_END;
              return;
            }
            if (i > seg) {
              parts.push(text.slice(seg, i));
              added += i - seg;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            i += 1;
            seg = i;
            continue;
          }
          i += 1;
        }
      }
      i += 1;
    }
    fVal = init === '' ? text.slice(start) : init + text.slice(start);
    uAdded = len - start;
    pos = len;
    fEnd = TEXT_END;
  }

  // Reads unquoted characters onto init, up to the next comma or line break. The first span is
  // walked in JS; a field that runs past it is finished with native scans. A stray CR anywhere
  // hands the field to the slow reader, which re-reads it from its start (pos has not moved).
  function readUnquoted(init) {
    const start = pos;
    let i = pos;
    let spanEnd = start + SCAN_SPAN;
    if (spanEnd > len) spanEnd = len;
    while (i < spanEnd) {
      const c = text.charCodeAt(i);
      if (c === 44) {
        fVal = init === '' ? text.slice(start, i) : init + text.slice(start, i);
        uAdded = i - start;
        pos = i + 1;
        fEnd = COMMA_END;
        return;
      }
      if (c === 10) {
        fVal = init === '' ? text.slice(start, i) : init + text.slice(start, i);
        uAdded = i - start;
        pos = i + 1;
        line += 1;
        fEnd = BREAK_END;
        return;
      }
      if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) {
          fVal = init === '' ? text.slice(start, i) : init + text.slice(start, i);
          uAdded = i - start;
          pos = i + 2;
          line += 1;
          fEnd = BREAK_END;
          return;
        }
        readUnquotedSlow(init);
        return;
      }
      i += 1;
    }
    if (i >= len) {
      fVal = init === '' ? text.slice(start) : init + text.slice(start);
      uAdded = len - start;
      pos = len;
      fEnd = TEXT_END;
      return;
    }
    // Long field: the terminator is found natively from here. The part already walked holds no
    // CR, so a CR inside the slice can only sit in the part still ahead.
    const ci = text.indexOf(',', i);
    const li = text.indexOf('\n', i);
    let end;
    let kind;
    if (li === -1 || (ci !== -1 && ci < li)) {
      if (ci === -1) {
        end = len;
        kind = TEXT_END;
      } else {
        end = ci;
        kind = COMMA_END;
      }
    } else {
      end = li;
      kind = BREAK_END;
    }
    const seg = text.slice(start, end);
    const cr = seg.indexOf('\r', i - start);
    if (cr === -1) {
      fVal = init === '' ? seg : init + seg;
      uAdded = seg.length;
      pos = kind === TEXT_END ? len : end + 1;
      if (kind === BREAK_END) line += 1;
      fEnd = kind;
      return;
    }
    if (kind === BREAK_END && cr === seg.length - 1) {
      // The only CR ahead is the one half of the CRLF that ends the field.
      const cut = seg.slice(0, seg.length - 1);
      fVal = init === '' ? cut : init + cut;
      uAdded = cut.length;
      pos = end + 1;
      line += 1;
      fEnd = BREAK_END;
      return;
    }
    readUnquotedSlow(init);
  }

  // What follows a closing quote: the field ends here, at a comma or at a line break, or the text up
  // to the next comma or line break is appended as it stands (quote_junk when anything was appended).
  function finishQuoted() {
    if (pos >= len) {
      fEnd = TEXT_END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fEnd = COMMA_END;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fEnd = BREAK_END;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fEnd = BREAK_END;
      return;
    }
    readUnquoted(fVal);
    if (uAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  // Reads a quoted field whose opening quote is at pos. Sets fVal and fEnd.
  // Fast tiers first: the first span is walked in JS (LFs counted along the way) and a clean field
  // there is one slice; a field still open past the span is finished natively — the closing quote is
  // found with indexOf and the value is one slice, provided that quote is undoubled and no CR hides
  // ahead of it. Anything else (a doubled quote, a CR inside, no closing quote at all) falls into the
  // segment build at the bottom: doubled quotes collapse to one, each CR or CRLF becomes one LF, and
  // a quote that never closes makes the opening quote a literal character whose field is read again
  // as unquoted.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const start = pos + 1;
    let j = start;
    let lf = 0;
    let spanEnd = start + SCAN_SPAN;
    if (spanEnd > len) spanEnd = len;
    while (j < spanEnd) {
      const c = text.charCodeAt(j);
      if (c === 34) {
        if (text.charCodeAt(j + 1) === 34) break; // doubled quote: segment build
        fVal = text.slice(start, j);
        line += lf;
        pos = j + 1;
        finishQuoted();
        return;
      }
      if (c === 13) break; // CR inside: segment build
      if (c === 10) lf += 1;
      j += 1;
    }
    if (j === spanEnd && j < len) {
      // Long field: finish natively if the shape stays clean.
      const q = text.indexOf('"', j);
      if (q !== -1 && text.charCodeAt(q + 1) !== 34) {
        const seg = text.slice(start, q);
        if (seg.indexOf('\r', j - start) === -1) {
          let p = seg.indexOf('\n', j - start);
          while (p !== -1) {
            lf += 1;
            p = seg.indexOf('\n', p + 1);
          }
          fVal = seg;
          line += lf;
          pos = q + 1;
          finishQuoted();
          return;
        }
      }
    }
    // Segment build: always from the start of the field (the walk above only ever counted LFs
    // into a local, so line is still the line the field opened on, as the build expects).
    j = start;
    const parts = [];
    let seg = start;
    for (;;) {
      if (j >= len) {
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      const c = text.charCodeAt(j);
      if (c === 34) {
        if (text.charCodeAt(j + 1) === 34) {
          if (j > seg) parts.push(text.slice(seg, j));
          parts.push('"');
          j += 2;
          seg = j;
          continue;
        }
        if (j > seg) parts.push(text.slice(seg, j));
        fVal = parts.join('');
        pos = j + 1;
        finishQuoted();
        return;
      }
      if (c === 13) {
        if (j > seg) parts.push(text.slice(seg, j));
        parts.push('\n');
        line += 1;
        j += text.charCodeAt(j + 1) === 10 ? 2 : 1;
        seg = j;
        continue;
      }
      if (c === 10) line += 1;
      j += 1;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    for (;;) {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        readQuoted();
      } else {
        lastQuoted = false;
        // The common unquoted field, scanned inline with the same two tiers as readUnquoted: a JS
        // walk over the first span, native scans for the rest of a long field. A stray CR in the
        // walked span hands the field to readUnquoted, which re-reads it from its start.
        const start = pos;
        let i = pos;
        let spanEnd = start + SCAN_SPAN;
    if (spanEnd > len) spanEnd = len;
        let ended = false;
        while (i < spanEnd) {
          const c = text.charCodeAt(i);
          if (c === 44) {
            fVal = text.slice(start, i);
            pos = i + 1;
            fEnd = COMMA_END;
            ended = true;
            break;
          }
          if (c === 10) {
            fVal = text.slice(start, i);
            pos = i + 1;
            line += 1;
            fEnd = BREAK_END;
            ended = true;
            break;
          }
          if (c === 13) {
            if (text.charCodeAt(i + 1) === 10) {
              fVal = text.slice(start, i);
              pos = i + 2;
              line += 1;
              fEnd = BREAK_END;
            } else {
              readUnquoted('');
            }
            ended = true;
            break;
          }
          i += 1;
        }
        if (!ended) {
          if (i >= len) {
            fVal = text.slice(start);
            pos = len;
            fEnd = TEXT_END;
          } else {
            const ci = text.indexOf(',', i);
            const li = text.indexOf('\n', i);
            let end;
            let kind;
            if (li === -1 || (ci !== -1 && ci < li)) {
              if (ci === -1) {
                end = len;
                kind = TEXT_END;
              } else {
                end = ci;
                kind = COMMA_END;
              }
            } else {
              end = li;
              kind = BREAK_END;
            }
            const seg = text.slice(start, end);
            const cr = seg.indexOf('\r', i - start);
            if (cr === -1) {
              fVal = seg;
              pos = kind === TEXT_END ? len : end + 1;
              if (kind === BREAK_END) line += 1;
              fEnd = kind;
            } else if (kind === BREAK_END && cr === seg.length - 1) {
              fVal = seg.slice(0, seg.length - 1);
              pos = end + 1;
              line += 1;
              fEnd = BREAK_END;
            } else {
              readUnquotedSlow('');
            }
          }
        }
      }
      fields.push(fVal);
      if (fEnd !== COMMA_END) break;
    }

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
