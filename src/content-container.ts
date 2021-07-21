import { getHash } from './hash';
import { isForeignObjectElement, isSvgDoc, SVG_NS } from './svg';

export function getOrCreateEmptyContainer({
  doc,
  id,
  legacyIds,
  styles,
}: {
  doc: Document;
  id: string;
  legacyIds?: Array<string>;
  styles: string;
}): HTMLElement {
  // Drop any legacy containers
  if (legacyIds?.length) {
    const legacyContainers = doc.querySelectorAll(
      legacyIds.map((id) => `#${id}`).join(', ')
    );
    for (const container of legacyContainers) {
      removeContainerElement(container);
    }
  }

  // Look for an existing container we can re-use
  const existingContainers = Array.from<HTMLElement>(
    doc.querySelectorAll(`#${id}`)
  );
  if (existingContainers.length) {
    // Drop any duplicate containers, returning only the last one
    while (existingContainers.length > 1) {
      removeContainerElement(existingContainers.shift()!);
    }

    // Drop any existing content (except styles)
    resetContent(existingContainers[0]);

    // Make sure the styles are up-to-date
    resetStyles({ container: existingContainers[0], doc, styles });

    return existingContainers[0];
  }

  // We didn't find an existing content container so create a new one

  // For SVG documents we put container <div> inside a <foreignObject>.
  let parent: Element;
  if (isSvgDoc(doc)) {
    const foreignObject = doc.createElementNS(SVG_NS, 'foreignObject');
    foreignObject.setAttribute('width', '100%');
    foreignObject.setAttribute('height', '100%');
    doc.documentElement.append(foreignObject);
    parent = foreignObject;
  } else {
    parent = doc.documentElement;
  }

  // Actually create the container element
  const container = doc.createElement('div');
  container.id = id;
  parent.append(container);

  // Reset any styles the page may have applied.
  container.style.all = 'initial';

  // Add the necessary style element
  resetStyles({ container, doc, styles });

  return container;
}

export function removeContentContainer(id: string | Array<string>) {
  const containerIds = typeof id === 'string' ? [id] : id;
  const containers = Array.from<HTMLElement>(
    document.querySelectorAll(containerIds.map((id) => `#${id}`).join(', '))
  );
  for (const container of containers) {
    removeContainerElement(container);
  }
}

// --------------------------------------------------------------------------
//
// Implementation helpers
//
// --------------------------------------------------------------------------

function removeContainerElement(elem: Element) {
  if (isForeignObjectElement(elem.parentElement)) {
    elem.parentElement.remove();
  } else {
    elem.remove();
  }
}

function resetContent(elem: HTMLElement) {
  if (!elem.shadowRoot) {
    return;
  }

  for (const child of elem.shadowRoot!.children) {
    if (child.tagName !== 'STYLE') {
      child.remove();
    }
  }
}

function resetStyles({
  container,
  doc,
  styles,
}: {
  container: HTMLElement;
  doc: Document;
  styles: string;
}) {
  const styleHash = getHash(styles);

  if (!container.shadowRoot) {
    container.attachShadow({ mode: 'open' });

    // Add <style>
    const style = doc.createElement('style');
    style.textContent = styles;
    style.dataset.hash = styleHash;
    container.shadowRoot!.append(style);
  } else {
    // Reset style
    let existingStyle = container.shadowRoot.querySelector('style');
    if (existingStyle && existingStyle.dataset.hash !== styleHash) {
      existingStyle.remove();
      existingStyle = null;
    }

    if (!existingStyle) {
      const style = doc.createElement('style');
      style.textContent = styles;
      style.dataset.hash = styleHash;
      container.shadowRoot!.append(style);
    }
  }
}
