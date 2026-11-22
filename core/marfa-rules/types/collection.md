**Use for**

- A named group of items, such as a reading list, a watch list, or a project's references.

**Not for**

- The items in the group. Each one is its own item.
- Another collection. A collection does not nest.

**Body**

- `title` is required and is the group's name. `description` says what the group is for.

**Edges**

- `in-collection` runs from each member to this collection. When saving a member, `in-collection` names this collection.
