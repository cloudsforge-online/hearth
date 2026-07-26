//! Difficulty retargeting for the production core.
//!
//! Difficulty is expressed as "leading zero bits" a Homefire digest must have
//! (see `pow::meets`). A linearly-weighted moving average (LWMA) of recent solve
//! times nudges the bits up when blocks come too fast and down when too slow,
//! keeping the network near its target block time.

/// Compute the next difficulty (in leading zero bits) from recent solve times.
///
/// * `cur_bits`       – current difficulty
/// * `recent_solves`  – solve times (seconds) of the last N blocks, oldest→newest
/// * `target_secs`    – desired seconds per block
/// * `(min_bits, max_bits)` – clamp range
pub fn next_bits(
    cur_bits: u32,
    recent_solves: &[u64],
    target_secs: u64,
    min_bits: u32,
    max_bits: u32,
) -> u32 {
    if recent_solves.is_empty() {
        return cur_bits.clamp(min_bits, max_bits);
    }
    // linearly-weighted average solve time (newer blocks weigh more)
    let mut weighted = 0u64;
    let mut weight_sum = 0u64;
    for (i, &s) in recent_solves.iter().enumerate() {
        let w = (i as u64) + 1;
        // clamp outliers to 6x target to blunt timestamp manipulation
        let clamped = s.clamp(1, target_secs.saturating_mul(6));
        weighted += clamped * w;
        weight_sum += w;
    }
    let avg = weighted / weight_sum.max(1);

    let next = if avg < target_secs {
        cur_bits + 1 // too fast → make it harder
    } else if avg > target_secs {
        cur_bits.saturating_sub(1) // too slow → make it easier
    } else {
        cur_bits
    };
    next.clamp(min_bits, max_bits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speeds_up_makes_harder() {
        // all blocks solved in 5s against a 15s target → harder
        assert_eq!(next_bits(20, &[5, 5, 5, 5], 15, 8, 40), 21);
    }

    #[test]
    fn slows_down_makes_easier() {
        assert_eq!(next_bits(20, &[40, 40, 40], 15, 8, 40), 19);
    }

    #[test]
    fn respects_clamp() {
        assert_eq!(next_bits(40, &[1, 1, 1], 15, 8, 40), 40); // can't exceed max
        assert_eq!(next_bits(8, &[99, 99], 15, 8, 40), 8); // can't drop below min
    }
}
