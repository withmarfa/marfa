//! `TraceIdRatioBased` as OpenTelemetry defines it, so a collector deciding the same way agrees.

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Sampler {
    On,
    Off,
    Ratio(f64),
}

impl Sampler {
    /// The low 63 bits of the id decide.
    pub fn keeps(self, trace_id: &[u8; 16]) -> bool {
        match self {
            Sampler::On => true,
            Sampler::Off => false,
            Sampler::Ratio(ratio) => {
                let bound = (ratio.clamp(0.0, 1.0) * (1u64 << 63) as f64) as u64;
                let low = u64::from_be_bytes(trace_id[8..].try_into().expect("eight bytes"));
                (low >> 1) < bound
            }
        }
    }

    /// A command has no parent trace, so a parent-based sampler decides as the one it wraps.
    /// An unreadable name or argument keeps every trace.
    pub fn named(name: Option<&str>, argument: Option<&str>) -> Sampler {
        let ratio = || {
            argument
                .and_then(|text| text.parse::<f64>().ok())
                .filter(|ratio| (0.0..=1.0).contains(ratio))
                .map_or(Sampler::On, Sampler::Ratio)
        };
        match name.map(str::to_ascii_lowercase).as_deref() {
            Some("always_off" | "parentbased_always_off") => Sampler::Off,
            Some("traceidratio" | "parentbased_traceidratio") => ratio(),
            _ => Sampler::On,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_standard_names_are_followed_and_the_default_keeps_every_trace() {
        let named = |name, argument| Sampler::named(Some(name), argument);
        assert_eq!(Sampler::named(None, None), Sampler::On);
        assert_eq!(named("always_on", None), Sampler::On);
        assert_eq!(named("always_off", None), Sampler::Off);
        assert_eq!(named("parentbased_always_off", None), Sampler::Off);
        assert_eq!(named("traceidratio", Some("0.25")), Sampler::Ratio(0.25));
        assert_eq!(
            named("parentbased_traceidratio", Some("0")),
            Sampler::Ratio(0.0)
        );
        assert_eq!(named("traceidratio", None), Sampler::On);
        assert_eq!(named("traceidratio", Some("2")), Sampler::On);
        assert_eq!(named("jaeger_remote", None), Sampler::On);
    }

    #[test]
    fn a_ratio_keeps_the_share_it_names_by_the_trace_id() {
        let id = |low: u64| {
            let mut id = [7u8; 16];
            id[8..].copy_from_slice(&low.to_be_bytes());
            id
        };
        assert!(Sampler::Ratio(1.0).keeps(&id(u64::MAX)));
        assert!(!Sampler::Ratio(0.0).keeps(&id(0)));
        assert!(Sampler::Ratio(0.5).keeps(&id(1 << 61)));
        assert!(!Sampler::Ratio(0.5).keeps(&id(1 << 63)));
        assert!(Sampler::On.keeps(&id(u64::MAX)));
        assert!(!Sampler::Off.keeps(&id(0)));
    }
}
