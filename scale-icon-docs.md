# Scale Icon SVG — Segment Control Doc

## Structure

The SVG contains **all 28 segments** (4 digit positions × 7 segments) and **2 decimal points**, all hidden by default. To display a number, add the `.on` class to the segments that should light up.

## Segment naming

```
 _a_      Standard 7-segment naming
f| |b
 |g|
e| |c
 |_|
   d
```

### CSS classes

| Element | Class pattern | Example |
|---|---|---|
| Segment | `seg-{position}-{letter}` | `seg-0-a`, `seg-3-g` |
| Decimal point | `dp-after-{position}` | `dp-after-2` |

- **`position`**: `0` (leftmost, hundreds), `1`, `2`, `3` (rightmost)
- **`letter`**: `a`, `b`, `c`, `d`, `e`, `f`, `g`

### Visibility classes

| Class | Effect |
|---|---|
| `.seg` / `.dp` (base) | Hidden by default |
| `.on` (add this) | Element becomes visible |
| `.default-on` | Pre-applied for the "72.5" default state — remove these classes from elements before taking JS control, or leave them for a static logo |

## Digit encoding

Each digit 0–9 is rendered by lighting a specific set of segments:

| Digit | Segments to light |
|---|---|
| `0` | a, b, c, d, e, f |
| `1` | b, c |
| `2` | a, b, g, e, d |
| `3` | a, b, g, c, d |
| `4` | f, g, b, c |
| `5` | a, f, g, c, d |
| `6` | a, f, g, e, c, d |
| `7` | a, b, c |
| `8` | a, b, c, d, e, f, g (all) |
| `9` | a, b, f, g, c, d |

## Examples

### Display "72.5"
Position 0 stays blank, position 1 = "7", position 2 = "2", position 3 = "5", with decimal between positions 2 and 3:

```
seg-1-a, seg-1-b, seg-1-c                          (digit "7")
seg-2-a, seg-2-b, seg-2-g, seg-2-e, seg-2-d        (digit "2")
dp-after-2                                          (decimal point)
seg-3-a, seg-3-f, seg-3-g, seg-3-c, seg-3-d        (digit "5")
```

All these elements should have the `.on` class.

### Display "150"
Three integer digits, no decimal:

```
seg-0-b, seg-0-c                                            (digit "1")
seg-1-a, seg-1-f, seg-1-g, seg-1-c, seg-1-d                 (digit "5")
seg-2-a, seg-2-b, seg-2-c, seg-2-d, seg-2-e, seg-2-f        (digit "0")
```

### Display "188.8"
All segments lit at every position, decimal after position 2.

## Rules for valid weight display

- **Range:** 0.0 to 999.9 (hundreds digit can show any 0–9, not just "1")
- **Without decimal:** values ≥ 100 with no fractional part use positions 0–2, leave position 3 blank, no decimal point lit
- **With decimal:** the integer part fills positions ending at position 2, and position 3 holds one decimal digit, with `dp-after-2` lit
- **Leading zero suppression:** for values < 10, leave position 1 blank (don't draw "0")
