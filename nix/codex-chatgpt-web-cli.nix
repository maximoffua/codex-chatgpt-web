# CLI core of codex-chatgpt-web: the daemon/engine behind the Electron
# launcher GUI (src/cli.ts — "serve", "setup", "doctor", MCP, service).
#
# The GUI is the main package at nix/codex-chatgpt-web.nix. Both derive from
# the flake's own source and version (package.json) and share nix/bun.nix,
# so one flake input pin moves both.
{
  lib,
  stdenvNoCC,
  bun,
  bun2nixLib,
  makeWrapper,
  versionCheckHook,

  # From the flake: filtered repo source and the version in package.json.
  src,
  version,
}:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "codex-chatgpt-web-cli";
  inherit version src;

  nativeBuildInputs = [
    bun2nixLib.hook
    makeWrapper
  ];

  bunDeps = bun2nixLib.fetchBunDeps { bunNix = ./bun.nix; };

  # The published bin is src/cli.ts run under bun — there is no bundle step.
  dontUseBunBuild = true;
  # The hook defaults, plus --production to keep devDependencies (typescript,
  # @types/*) out of the runtime closure.
  bunInstallFlags = [
    "--linker=isolated"
    "--backend=symlink"
    "--production"
  ];
  # No lifecycle scripts are needed at build time and none may run in the
  # sandbox.
  dontRunLifecycleScripts = true;

  installPhase = ''
    runHook preInstall

    # Not $out/share/codex-chatgpt-web: that is the desktop GUI's runtime
    # tree, and the two store paths must not collide when installed
    # side-by-side.
    mkdir -p $out/share/codex-chatgpt-web-cli
    cp -r src node_modules package.json tsconfig.json $out/share/codex-chatgpt-web-cli/

    makeWrapper ${lib.getExe bun} $out/bin/codex-chatgpt-web-cli \
      --add-flags "$out/share/codex-chatgpt-web-cli/src/cli.ts"

    runHook postInstall
  '';

  doInstallCheck = true;
  nativeInstallCheckInputs = [ versionCheckHook ];

  meta = with lib; {
    description = "Use ChatGPT Web (including Pro) as native Codex models with context, tools, streaming and images";
    homepage = "https://github.com/miuuyy/codex-chatgpt-web";
    changelog = "https://github.com/miuuyy/codex-chatgpt-web/releases/tag/v${finalAttrs.version}";
    license = licenses.mit;
    sourceProvenance = with sourceTypes; [ fromSource ];
    mainProgram = "codex-chatgpt-web-cli";
    platforms = platforms.unix;
  };
})
