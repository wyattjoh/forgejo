# Build both adapters from the same core library. No dependency installation
# or network access occurs in buildPhase or at service startup.
{
  pkgs,
  src ? ./.,
}:
let
  inherit (pkgs) lib;
  manifest = builtins.fromJSON (builtins.readFile "${src}/nix/dependencies.json");
  unpack =
    dep:
    let
      archive = pkgs.fetchurl { inherit (dep) url hash; };
    in
    ''
      mkdir -p node_modules/${lib.escapeShellArg dep.location}
      tar -xzf ${archive} --strip-components=1 -C node_modules/${lib.escapeShellArg dep.location}
    '';
in
assert lib.assertMsg (
  builtins.hashFile "sha256" "${src}/bun.lock" == manifest.lockHash
) "Forgejo Nix dependency manifest does not match bun.lock";
pkgs.stdenvNoCC.mkDerivation {
  pname = "forgejo-tools";
  version = (builtins.fromJSON (builtins.readFile "${src}/package.json")).version;
  src = lib.cleanSourceWith {
    inherit src;
    filter =
      path: type:
      let
        relative = lib.removePrefix "${toString src}/" (toString path);
      in
      !(lib.any (
        part:
        lib.elem part [
          ".git"
          "node_modules"
          "dist"
          "data"
        ]
      ) (lib.splitString "/" relative))
      && (
        type == "directory"
        || (
          lib.hasPrefix "packages/" relative
          && (lib.hasSuffix ".ts" relative || lib.hasSuffix ".json" relative)
        )
        || lib.elem relative [
          "package.json"
          "bun.lock"
          "tsconfig.json"
          "LICENSE"
        ]
      );
  };
  nativeBuildInputs = [
    pkgs.bun
    pkgs.makeWrapper
  ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    ${lib.concatMapStringsSep "\n" unpack manifest.dependencies}
    ${lib.concatMapStringsSep "\n" (workspace: ''
      mkdir -p node_modules/${lib.escapeShellArg (builtins.dirOf workspace.name)}
      ln -s "$PWD/${workspace.path}" node_modules/${lib.escapeShellArg workspace.name}
    '') manifest.workspaces}
    bun build --target=bun packages/forgejo-mcp/src/main.ts --outfile forgejo-mcp.mjs
    bun build --target=bun packages/forgejo-cli/src/main.ts --outfile forgejo.mjs
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm644 forgejo-mcp.mjs "$out/lib/forgejo-mcp.mjs"
    install -Dm644 forgejo.mjs "$out/lib/forgejo.mjs"
    makeWrapper ${pkgs.bun}/bin/bun "$out/bin/forgejo-mcp" --add-flags "$out/lib/forgejo-mcp.mjs"
    makeWrapper ${pkgs.bun}/bin/bun "$out/bin/forgejo" --add-flags "$out/lib/forgejo.mjs" \
      ${lib.optionalString pkgs.stdenv.hostPlatform.isLinux "--prefix LD_LIBRARY_PATH : ${
        lib.makeLibraryPath [
          pkgs.libsecret
          pkgs.glib
        ]
      }"}
    runHook postInstall
  '';
  meta = {
    description = "Forgejo CLI and HTTP MCP server sharing the Forgejo core library";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
    mainProgram = "forgejo";
  };
}
