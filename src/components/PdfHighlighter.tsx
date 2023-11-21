import "pdfjs-dist/web/pdf_viewer.css";
import "../style/PdfHighlighter.css";
import "../style/pdf_viewer.css";

import debounce from "lodash.debounce";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  EventBus,
  NullL10n,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/legacy/web/pdf_viewer";
import React, {
  CSSProperties,
  PointerEventHandler,
  ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { Root, createRoot } from "react-dom/client";
import { scaledToViewport, viewportPositionToScaled } from "../lib/coordinates";
import getBoundingRect from "../lib/get-bounding-rect";
import getClientRects from "../lib/get-client-rects";
import groupHighlightsByPage from "../lib/group-highlights-by-page";
import {
  asElement,
  findOrCreateContainerLayer,
  getPagesFromRange,
  getWindow,
  isHTMLElement,
} from "../lib/pdfjs-dom";
import type {
  Content,
  GhostHighlight,
  Highlight,
  ViewportPosition,
  ScaledPosition,
  Tip,
} from "../types";
import TipRenderer from "./TipRenderer";
import HighlightLayer from "./HighlightLayer";
import MouseSelectionRenderer from "./MouseSelectionRenderer";

interface Props {
  highlights: Array<Highlight>;
  onScrollChange: () => void;
  scrollRef: (scrollTo: (highlight: Highlight) => void) => void;
  pdfDocument: PDFDocumentProxy;
  pdfScaleValue?: string;
  onSelectionFinished: (
    position: ScaledPosition,
    content: Content,
    hideTipAndGhostHighlight: () => void,
    transformSelection: () => void
  ) => ReactElement | null;
  enableAreaSelection?: (event: MouseEvent) => boolean;
  mouseSelectionStyle?: CSSProperties;
  children: ReactElement;
}

interface HighlightRoot {
  reactRoot: Root;
  container: Element;
}

const PdfHighlighter = ({
  highlights,
  onScrollChange,
  scrollRef,
  pdfDocument,
  pdfScaleValue = "auto",
  onSelectionFinished,
  enableAreaSelection,
  mouseSelectionStyle,
  children,
}: Props) => {
  const highlightsRef = useRef(highlights); // Keep track of all highlights
  const ghostHighlightRef = useRef<GhostHighlight | null>(null); // Keep track of in-progress highlights
  const isCollapsedRef = useRef(true); // Keep track of whether or not there is text in the selection
  const rangeRef = useRef<Range | null>(null); // Keep track of nodes and text nodes in selection
  const scrolledToHighlightIdRef = useRef<string | null>(null); // Keep track of id of highlight scrolled to
  const isAreaSelectionInProgressRef = useRef(false); // Keep track of whether area selection is made
  const pdfScaleValueRef = useRef(pdfScaleValue);
  const [_, setTip] = useState<Tip | null>(null); // Keep track of external Tip properties (highlight, content)
  const [tipPosition, setTipPosition] = useState<ViewportPosition | null>(null);
  const [tipChildren, setTipChildren] = useState<ReactElement | null>(null);

  const containerNodeRef = useRef<HTMLDivElement | null>(null);
  const highlightRootsRef = useRef<{ [page: number]: HighlightRoot }>({});
  const eventBusRef = useRef<EventBus>(new EventBus());
  const linkServiceRef = useRef<PDFLinkService>(
    new PDFLinkService({
      eventBus: eventBusRef.current,
      externalLinkTarget: 2,
    })
  );
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const [isViewerReady, setViewerReady] = useState(false);

  useEffect(() => {
    resizeObserverRef.current = new ResizeObserver(debouncedScaleValue);
    const doc = containerNodeRef.current?.ownerDocument;
    if (!doc || !containerNodeRef.current) return;

    eventBusRef.current.on("textlayerrendered", renderHighlightLayers);
    eventBusRef.current.on("pagesinit", onDocumentReady);
    doc.addEventListener("selectionchange", onSelectionChange);
    doc.addEventListener("keydown", handleKeyDown);
    resizeObserverRef.current.observe(containerNodeRef.current);

    viewerRef.current =
      viewerRef.current ||
      new PDFViewer({
        container: containerNodeRef.current!,
        eventBus: eventBusRef.current,
        textLayerMode: 2,
        removePageBorders: true,
        linkService: linkServiceRef.current,
        l10n: NullL10n,
      });

    linkServiceRef.current.setDocument(pdfDocument);
    linkServiceRef.current.setViewer(viewerRef.current);
    viewerRef.current.setDocument(pdfDocument);

    setViewerReady(true);

    return () => {
      eventBusRef.current.off("pagesinit", onDocumentReady);
      eventBusRef.current.off("textlayerrendered", renderHighlightLayers);
      doc.removeEventListener("selectionchange", onSelectionChange);
      doc.removeEventListener("keydown", handleKeyDown);
      resizeObserverRef.current?.disconnect();
      setViewerReady(false);
    };
  }, []);

  useEffect(() => {
    highlightsRef.current = highlights;
    renderHighlightLayers();
  }, [highlights]);

  const findOrCreateHighlightLayer = (page: number) => {
    const { textLayer } = viewerRef.current!.getPageView(page - 1) || {};
    if (!textLayer) return null;

    return findOrCreateContainerLayer(
      textLayer.div,
      "PdfHighlighter__highlight-layer"
    );
  };

  const showTip = (tip: Tip) => {
    // Check if highlight is in progress
    // Don't show an existing tip if a selection goes over it
    // Don't show any tips if a ghost selection is made
    if (
      !isCollapsedRef.current ||
      ghostHighlightRef.current ||
      isAreaSelectionInProgressRef.current
    )
      return;
    setTipPosition(tip.highlight.position);

    if (typeof tip.content === "function") {
      setTipChildren(tip.content(tip.highlight));
    } else {
      // content is a plain ReactElement
      setTipChildren(tip.content);
    }
  };

  const hideTipAndGhostHighlight = () => {
    setTipPosition(null);
    setTipChildren(null);
    ghostHighlightRef.current = null;
    setTip(null);
    renderHighlightLayers();
  };

  const scrollTo = (highlight: Highlight) => {
    const { boundingRect, usePdfCoordinates } = highlight.position;
    const pageNumber = boundingRect.pageNumber;

    viewerRef.current!.container.removeEventListener("scroll", onScroll);

    const pageViewport = viewerRef.current!.getPageView(
      pageNumber - 1
    ).viewport;

    const scrollMargin = 10;

    viewerRef.current!.scrollPageIntoView({
      pageNumber,
      destArray: [
        null, // null since we pass pageNumber already as an arg
        { name: "XYZ" },
        ...pageViewport.convertToPdfPoint(
          0, // Default x coord
          scaledToViewport(boundingRect, pageViewport, usePdfCoordinates).top -
            scrollMargin
        ),
        0, // Default z coord
      ],
    });

    scrolledToHighlightIdRef.current = highlight.id;
    renderHighlightLayers();

    // wait for scrolling to finish
    setTimeout(() => {
      viewerRef.current!.container.addEventListener("scroll", onScroll);
    }, 100);
  };

  const onDocumentReady = () => {
    debouncedScaleValue();
    scrollRef(scrollTo);
  };

  const onSelectionChange = () => {
    const container = containerNodeRef.current;
    const selection = getWindow(container).getSelection();

    if (!selection) return;

    const newRange = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    if (selection.isCollapsed) {
      isCollapsedRef.current = true;
      return;
    }

    if (
      !newRange ||
      !container ||
      !container.contains(newRange.commonAncestorContainer) // Sanity check the selected text is in the container
    ) {
      return;
    }

    isCollapsedRef.current = false;
    rangeRef.current = newRange;
    debouncedAfterSelection();
  };

  const onScroll = () => {
    onScrollChange();
    scrolledToHighlightIdRef.current = null;
    renderHighlightLayers();
  };

  const onMouseDown: PointerEventHandler = (event) => {
    if (
      !isHTMLElement(event.target) ||
      asElement(event.target).closest(".PdfHighlighter__tip-container") // Ignore selections on tip container
    ) {
      return;
    }

    hideTipAndGhostHighlight();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.code === "Escape") {
      console.log("Escape!");
      renderHighlightLayers();
      // hideTipAndGhostHighlight();
    }
  };

  const afterSelection = () => {
    if (!rangeRef.current || isCollapsedRef.current) {
      return;
    }

    const pages = getPagesFromRange(rangeRef.current);
    if (!pages || pages.length === 0) {
      return;
    }

    const rects = getClientRects(rangeRef.current, pages);
    if (rects.length === 0) {
      return;
    }

    const boundingRect = getBoundingRect(rects);
    const viewportPosition: ViewportPosition = {
      boundingRect,
      rects,
    };

    const content = { text: rangeRef.current.toString() };
    const scaledPosition = viewportPositionToScaled(
      viewportPosition,
      viewerRef.current!
    );

    setTipPosition(viewportPosition);
    setTipChildren(
      onSelectionFinished(
        scaledPosition,
        content,
        hideTipAndGhostHighlight,
        () => {
          ghostHighlightRef.current = {
            content: content,
            position: scaledPosition,
          };
          renderHighlightLayers();
        }
      )
    );
  };

  const debouncedAfterSelection = debounce(afterSelection, 100);

  const handleScaleValue = () => {
    if (viewerRef) {
      viewerRef.current!.currentScaleValue = pdfScaleValueRef.current; //"page-width";
    }
  };

  useEffect(() => {
    pdfScaleValueRef.current = pdfScaleValue;
    debouncedScaleValue();
  }, [pdfScaleValue]);

  const debouncedScaleValue = debounce(handleScaleValue, 100);

  const renderHighlightLayers = () => {
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
      const highlightRoot = highlightRootsRef.current[pageNumber];

      // Need to check if container is still attached to the DOM as PDF.js can unload pages.
      if (highlightRoot?.container?.isConnected) {
        renderHighlightLayer(highlightRoot.reactRoot, pageNumber);
      } else {
        const highlightLayer = findOrCreateHighlightLayer(pageNumber);

        if (highlightLayer) {
          const reactRoot = createRoot(highlightLayer);
          highlightRootsRef.current[pageNumber] = {
            reactRoot,
            container: highlightLayer,
          };
          renderHighlightLayer(reactRoot, pageNumber);
        }
      }
    }
  };

  const renderHighlightLayer = (root: Root, pageNumber: number) => {
    if (!viewerRef.current) return;

    root.render(
      <HighlightLayer
        highlightsByPage={groupHighlightsByPage([
          ...highlightsRef.current,
          ghostHighlightRef.current,
        ])}
        pageNumber={pageNumber}
        scrolledToHighlightId={scrolledToHighlightIdRef.current}
        hideTipAndGhostHighlight={hideTipAndGhostHighlight}
        viewer={viewerRef.current}
        showTip={showTip}
        setTip={setTip}
        children={children}
      />
    );
  };

  console.log("Re-rendered!");

  return (
    <div onPointerDown={onMouseDown}>
      <div ref={containerNodeRef} className="PdfHighlighter">
        <div className="pdfViewer" />
        {isViewerReady && (
          <TipRenderer
            tipPosition={tipPosition}
            tipChildren={tipChildren}
            viewer={viewerRef.current!}
          />
        )}
        {isViewerReady && enableAreaSelection && (
          <MouseSelectionRenderer
            viewer={viewerRef.current!}
            onChange={(isVisible) =>
              (isAreaSelectionInProgressRef.current = isVisible)
            }
            enableAreaSelection={enableAreaSelection}
            style={mouseSelectionStyle}
            afterSelection={(
              viewportPosition,
              scaledPosition,
              image,
              resetSelection
            ) => {
              setTipPosition(viewportPosition);
              setTipChildren(
                onSelectionFinished(
                  scaledPosition,
                  { image },
                  hideTipAndGhostHighlight,
                  () => {
                    ghostHighlightRef.current = {
                      position: scaledPosition,
                      content: { image },
                    };
                    resetSelection();
                    renderHighlightLayers();
                  }
                )
              );
            }}
          />
        )}
      </div>
    </div>
  );
};

export default PdfHighlighter;
