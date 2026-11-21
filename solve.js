// A single-pass CSV reader with csv-reader 1.0.0's exact reading policy, written for speed.
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
// Where the speed comes from: the text is scanned once with charCodeAt, field values are cut out with
// String.slice instead of being built a character at a time, the common unquoted field is scanned
// inline in the record loop, and the field readers report through shared local channels instead of
// allocating a result object per field. Slow paths (a stray CR in an unquoted field, doubled quotes
// or CRs inside a quoted one) assemble the value from slice segments. Nothing is kept between calls:
// all state lives inside run().

const COMMA_END = 0;
const BREAK_END = 1;
const TEXT_END = 2;

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

  // Reads unquoted characters onto init, up to the next comma or line break. A CR not followed by LF
  // is dropped (stray_cr). Sets fVal, fEnd and uAdded.
  function readUnquoted(init) {
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
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const start = pos + 1;
    // Fast scan for the closing quote: a clean field (no CR, no doubled quote before it) is one slice.
    let j = start;
    let lf = 0;
    let messy = false;
    while (j < len) {
      const c = text.charCodeAt(j);
      if (c === 34) {
        if (text.charCodeAt(j + 1) === 34) messy = true;
        break;
      }
      if (c === 13) {
        messy = true;
        break;
      }
      if (c === 10) lf += 1;
      j += 1;
    }
    if (j >= len) {
      // The quote never closes: it is a literal character and the rest is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    if (!messy) {
      fVal = text.slice(start, j);
      line += lf;
      pos = j + 1;
      finishQuoted();
      return;
    }
    // Segment build: doubled quotes collapse to one, each CR or CRLF becomes one LF.
    const parts = [];
    let seg = start;
    j = start;
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
        // The common unquoted field, scanned inline: one slice up to its terminator. A stray CR
        // (rare) hands the field to readUnquoted, which re-reads it from its start.
        const start = pos;
        let i = pos;
        let ended = false; // a terminator was met (or a stray CR handed the field over)
        while (i < len) {
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
              ended = true;
            } else {
              readUnquoted('');
              ended = true;
            }
            break;
          }
          i += 1;
        }
        if (!ended) {
          // The scan ran off the end of the text without meeting a terminator.
          fVal = text.slice(start);
          pos = len;
          fEnd = TEXT_END;
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
