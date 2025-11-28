{
  description = "actual-sparebank1 - Actual Budget integration";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs = {
    self,
    nixpkgs,
  }: let
    pkgs = nixpkgs.legacyPackages."x86_64-linux";
  in {
    packages."x86_64-linux".default = pkgs.buildNpmPackage {
      pname = "actual-sparebank1";
      version = "0.1.0";
      src = ./.;
      npmDepsHash = "sha256-uwOJt6bAcKAbB9pr6Thl9wipN92IsAUlKqAA2paPiSM=";
    };
  };
}
