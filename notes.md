Pluggable generators:

    Enhance the interface for level generation so that [level-builder.js](src/world/level-builder.js) is merely the first reference implementation for an expandable library of generators
    these generators should be easily added to the code base as a single file and a single line into a manifest dictionary
    the parameters exposed by a generator should be communicated dynamically and supported by the level builder ui appropriately
    provide a markdown document noting how to add a new generator with a typescript-based interface contract

