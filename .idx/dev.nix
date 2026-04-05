{ pkgs, ... }: {
  channel = "stable-24.05";
  
  packages = [
    pkgs.nodejs_20
    pkgs.nodePackages.nodemon
  ];
  
  env = {};
  
  idx = {
    extensions = [];
    
    # This block tells IDX exactly how to preview your app
    previews = {
      enable = true;
      previews = {
        web = {
          command = ["npx" "nodemon" "index.js"];
          manager = "web";
          env = {
            PORT = "$PORT";
          };
        };
      };
    };
  };
}