use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

pub fn run(remote: &Remote, out: &Printer) -> Result<(), CliError> {
    out.value(&remote.json(&Request::get(&["metrics"]))?)
}
