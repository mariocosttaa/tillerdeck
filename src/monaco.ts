// O Monaco vem no bundle, não de uma CDN: a app tem de abrir sem rede.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import { configureMonacoYaml } from "monaco-yaml";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import YamlWorker from "monaco-yaml/yaml.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "yaml") return new YamlWorker();
    return new EditorWorker();
  },
};

configureMonacoYaml(monaco, {
  enableSchemaRequest: false,
  validate: true,
  completion: true,
  hover: true,
  // O Ansible usa tags próprias; sem isto aparecem como erro.
  customTags: ["!vault scalar", "!unsafe scalar"],
});


loader.config({ monaco });

export { monaco };
