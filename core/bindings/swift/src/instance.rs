use crate::MarfaError;

#[derive(Debug, Clone, uniffi::Record)]
pub struct InstanceDescription {
    pub name: String,
    pub version: String,
    pub release: Option<String>,
    pub instance_id: String,
    pub contract: u64,
    pub features: Vec<String>,
}

#[uniffi::export]
pub fn instance_description(url: String) -> Result<InstanceDescription, MarfaError> {
    let description = marfa_core::instance_description(&url)?;
    Ok(InstanceDescription {
        name: description.name,
        version: description.version,
        release: description.release,
        instance_id: description.instance_id,
        contract: description.contract,
        features: description.features,
    })
}
