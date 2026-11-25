//! `aether`: the command line for reading and writing an Aether notes
//! folder with the app closed. Installed on PATH as `aether`.

use clap::Parser;

#[derive(Parser)]
#[command(
    name = "aether",
    bin_name = "aether",
    version,
    about = "Read and write Aether pages from the shell"
)]
struct Cli {}

fn main() {
    Cli::parse();
}
