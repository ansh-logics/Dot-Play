// Compiles swift/LyricAlternates.swift into a static library and links it (macOS only).
// Included by build.rs. The Swift runtime comes from the OS (/usr/lib/swift); the toolchain's
// directory supplies the small back-deployment libraries. Translation is linked weakly so the
// app still starts on macOS versions without it (the code checks #available before using it).

use std::path::{Path, PathBuf};
use std::process::Command;

fn xcrun(args: &[&str]) -> String {
  let out = Command::new("xcrun").args(args).output().expect("xcrun not found: install Xcode or the Command Line Tools");
  assert!(out.status.success(), "xcrun {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
  String::from_utf8(out.stdout).unwrap().trim().to_string()
}

pub fn build() {
  let source = "swift/LyricAlternates.swift";
  println!("cargo:rerun-if-changed={source}");

  let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
    "aarch64" => "arm64",
    other => other,
  }
  .to_string();
  // Matches bundle.macOS.minimumSystemVersion in tauri.conf.json.
  let target = format!("{arch}-apple-macosx13.0");
  let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
  let lib = out_dir.join("libdot_alternates.a");
  let sdk = xcrun(&["--sdk", "macosx", "--show-sdk-path"]);

  let status = Command::new("xcrun")
    .args(["swiftc", "-parse-as-library", "-swift-version", "5", "-O", "-whole-module-optimization"])
    .args(["-target", &target, "-sdk", &sdk])
    .args(["-emit-library", "-static", "-module-name", "DotAlternates", "-o"])
    .arg(&lib)
    .arg(source)
    .status()
    .expect("failed to run swiftc");
  assert!(status.success(), "swiftc failed to compile {source}");

  let swiftc = xcrun(&["--find", "swiftc"]);
  let toolchain_lib = Path::new(&swiftc).parent().unwrap().parent().unwrap().join("lib/swift/macosx");

  println!("cargo:rustc-link-search=native={}", out_dir.display());
  println!("cargo:rustc-link-lib=static=dot_alternates");
  println!("cargo:rustc-link-search=native={}", toolchain_lib.display());
  println!("cargo:rustc-link-search=native=/usr/lib/swift");
  println!("cargo:rustc-link-search=native={sdk}/usr/lib/swift");
  println!("cargo:rustc-link-lib=framework=Foundation");
  println!("cargo:rustc-link-lib=framework=NaturalLanguage");
  println!("cargo:rustc-link-arg=-Wl,-weak_framework,Translation");
  // Swift concurrency is linked as @rpath/libswift_Concurrency.dylib when targeting macOS 13;
  // the OS copy lives in /usr/lib/swift.
  println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}
