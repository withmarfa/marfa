//! Questions asked on the terminal. Nothing is asked when `--yes` is given or
//! standard input is not a terminal: the flag or the default answers instead,
//! and a question with neither is refused with the flag that answers it.

use std::io::{self, BufRead, IsTerminal, Write};

use crate::error::CliError;

pub struct Prompter {
    asking: bool,
}

impl Prompter {
    pub fn new(yes: bool) -> Self {
        Self {
            asking: !yes && io::stdin().is_terminal(),
        }
    }

    pub fn asking(&self) -> bool {
        self.asking
    }

    fn line(&self, question: &str) -> Result<String, CliError> {
        let mut err = io::stderr().lock();
        write!(err, "{question} ")?;
        err.flush()?;
        let mut answer = String::new();
        if io::stdin().lock().read_line(&mut answer)? == 0 {
            return Err(CliError::Usage(
                "standard input ended before the answer".into(),
            ));
        }
        Ok(answer.trim().to_string())
    }

    /// One of `options`, by number or by name. `flag` is what to pass instead.
    pub fn choose(
        &self,
        question: &str,
        options: &[(&str, &str)],
        default: Option<usize>,
        flag: &str,
    ) -> Result<usize, CliError> {
        if !self.asking {
            return default.ok_or_else(|| CliError::Usage(format!("pass {flag}")));
        }
        eprintln!("{question}");
        for (index, (name, description)) in options.iter().enumerate() {
            eprintln!("  {}. {name}: {description}", index + 1);
        }
        loop {
            let hint = default.map_or(String::new(), |d| format!(" [{}]", d + 1));
            let answer = self.line(&format!("Choose 1-{}{hint}:", options.len()))?;
            if answer.is_empty()
                && let Some(default) = default
            {
                return Ok(default);
            }
            if let Ok(number) = answer.parse::<usize>()
                && (1..=options.len()).contains(&number)
            {
                return Ok(number - 1);
            }
            if let Some(found) = options.iter().position(|(name, _)| *name == answer) {
                return Ok(found);
            }
            eprintln!("Answer with a number from 1 to {}.", options.len());
        }
    }

    pub fn text(
        &self,
        question: &str,
        default: Option<&str>,
        flag: &str,
    ) -> Result<String, CliError> {
        if !self.asking {
            return default
                .map(str::to_string)
                .ok_or_else(|| CliError::Usage(format!("pass {flag}")));
        }
        loop {
            let hint = default.map_or(String::new(), |d| format!(" [{d}]"));
            let answer = self.line(&format!("{question}{hint}:"))?;
            if !answer.is_empty() {
                return Ok(answer);
            }
            if let Some(default) = default {
                return Ok(default.to_string());
            }
        }
    }

    pub fn yes_no(&self, question: &str, default: bool) -> Result<bool, CliError> {
        if !self.asking {
            return Ok(default);
        }
        let hint = if default { "[Y/n]" } else { "[y/N]" };
        loop {
            match self
                .line(&format!("{question} {hint}"))?
                .to_lowercase()
                .as_str()
            {
                "" => return Ok(default),
                "y" | "yes" => return Ok(true),
                "n" | "no" => return Ok(false),
                _ => eprintln!("Answer y or n."),
            }
        }
    }

    pub fn secret(&self, question: &str, flag: &str) -> Result<String, CliError> {
        if !self.asking {
            return Err(CliError::Usage(format!("pass {flag}")));
        }
        let answer = rpassword::prompt_password(format!("{question}: "))?;
        if answer.is_empty() {
            return Err(CliError::Usage(format!("{question} is empty")));
        }
        Ok(answer)
    }
}
