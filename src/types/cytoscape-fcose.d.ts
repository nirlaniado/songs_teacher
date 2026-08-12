declare module "cytoscape-fcose" {
  import type cytoscape from "cytoscape";
  const fcose: (cy: typeof cytoscape) => void;
  export default fcose;
}
