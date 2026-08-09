declare module "yamljs" {
  const YAML: { load: (path: string) => unknown };
  export default YAML;
}
