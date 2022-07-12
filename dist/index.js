import fastifyPlugin from "fastify-plugin";
import yaml from "js-yaml";
import { buildSpec } from "./spec.js";
import { addUI } from "./ui.js";
export const plugin = fastifyPlugin(function(instance, options, done) {
    let prefix = options.prefix ?? "/docs";
    let spec = options.openapi ?? {};
    const routes = [];
    if (prefix.indexOf("/") !== 0) {
        prefix = `/${prefix}`;
    }
    if (!options.skipUI) {
        addUI(instance, prefix);
    }
    // Register spec routes
    instance.route({
        method: "GET",
        url: `${prefix}/openapi.yaml`,
        handler (_, reply) {
            reply.type("text/yaml");
            reply.send(yaml.dump(spec));
        },
        config: {
            hide: false
        }
    });
    instance.route({
        method: "GET",
        url: `${prefix}/openapi.json`,
        handler (_, reply) {
            reply.send(spec);
        },
        config: {
            hide: false
        }
    });
    // Utility to track all the RouteOptions we add
    instance.addHook("onRoute", (route)=>{
        routes.push(route);
    });
    // When the server starts, add all schemas and routes to the spec
    instance.addHook("onReady", (done)=>{
        spec = buildSpec(instance, spec, instance.getSchemas(), routes);
        done();
    });
    done();
}, {
    name: "fastify-openapi-docs"
});
export default plugin;
