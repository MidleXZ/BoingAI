use std::env;
use std::path::PathBuf;

fn main() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let cpp_lib = PathBuf::from(manifest_dir)
        .parent().unwrap()
        .join("cpp-lib");
    let lib_dir = cpp_lib.clone();
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=dylib=boing_text");
    // rpath is an ELF/Mach-O linker flag; MSVC does not understand it.
    if target_os != "windows" {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_dir.display());
    }
    // Rebuild if the shared library changes
    println!("cargo:rerun-if-changed={}", cpp_lib.join("libboing_text.so").display());
    println!("cargo:rerun-if-changed={}", cpp_lib.join("libboing_text.dylib").display());
    println!("cargo:rerun-if-changed={}", cpp_lib.join("boing_text.dll").display());
}
