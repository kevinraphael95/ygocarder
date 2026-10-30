import { useCallback, useEffect, useRef } from 'react';
import { compressCardData, insertUrlParam, normalizeCardName } from 'src/util';
import { saveCardLocally, useCard } from './use-card';
import { useSetting } from './use-setting';
import { useLanguage } from './use-i18n';
import { useBatchDownload } from './use-batch-download';
import { ExportCallbackParameter } from './use-master-seri';

export type UseCardExport = {
    isTainted: boolean,
    isInitializing: boolean,
    exportCanvasRef: React.RefObject<HTMLCanvasElement>,
    exportRef: React.MutableRefObject<{
        currentPipeline: Promise<void>;
        pipelineRunning: boolean;
    }>,
    onExport: (
        exportProps: Pick<ExportCallbackParameter, 'isPendulum' | 'isRelevant' | 'opacity' | 'pendulumSize'>,
    ) => Promise<void>,
    onDownloadError: () => void,
    onDownloadComplete: () => void,
};

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/**
 * Wait until every cropper image is fully loaded, then let React + the cropper redraw (2 frames).
 * Used in batch mode BEFORE the export pipeline starts, so the export canvas never gets drawn with the previous card's art.
 */
const waitForArtReady = async () => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>('.ReactCrop img'));
    await Promise.all(images.map(img => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise<void>(resolve => {
            const done = () => resolve();
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
            setTimeout(done, 3000); // safety net
        });
    }));
    await nextFrame();
    await nextFrame();
};

/** To ensure the best performance, all of this hook's paramter must be memozied. */
export const useCardExport = ({
    isTainted,
    isInitializing,
    exportCanvasRef,
    exportRef,
    onExport,
    onDownloadError,
    onDownloadComplete,
}: UseCardExport) => {
    const language = useLanguage();
    const {
        card: currentCard,
    } = useCard();
    const {
        addToBatch,
        batchDataMap,
        isBatchDownloading,
    } = useBatchDownload();
    const resolution = useSetting(state => state.setting.resolution);
    const exportScheme = useSetting(state => state.setting.exportScheme);
    const {
        opacity,
        name,
        isPendulum,
        pendulumSize,
    } = currentCard;
    const normalizedName = normalizeCardName(name);
    const pendingSave = useRef(false);

    /** Clone the export canvas at the requested size and return a PNG blob. */
    const getCardBlob = useCallback((size: [number, number] = resolution): Promise<Blob | null> => {
        const drawCanvas = exportCanvasRef.current;
        const clonedCanvas = drawCanvas?.cloneNode() as HTMLCanvasElement | null;
        if (!drawCanvas || !clonedCanvas || isTainted) return Promise.resolve(null);

        clonedCanvas.width = size[0];
        clonedCanvas.height = size[1];
        const clonedCtx = clonedCanvas.getContext('2d');
        if (!clonedCtx) return Promise.resolve(null);

        clonedCtx.drawImage(
            drawCanvas,
            0, 0, drawCanvas.width, drawCanvas.height,
            0, 0, clonedCanvas.width, clonedCanvas.height,
        );

        return new Promise(resolve => clonedCanvas.toBlob(resolve, 'image/png'));
    }, [exportCanvasRef, isTainted, resolution]);

    /** Legacy data-url helper, kept for the single-card download path. */
    const getCardDataUrl = useCallback(async (size: [number, number] = resolution) => {
        const blob = await getCardBlob(size);
        if (!blob) return undefined;
        return new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }, [getCardBlob]);

    const addToCurrentBatch = useCallback(async (
        cardName: string,
        cardId: string,
        size: [number, number] = resolution,
    ) => {
        try {
            // Wait for the browser to actually paint the canvas before snapshotting it.
            await nextFrame();
            const blob = await getCardBlob(size);
            if (!blob) throw new Error('Failed to add card to batch');
            if (isBatchDownloading) addToBatch(cardId, cardName, blob);
        } catch (e) {
            onDownloadError();
        }
        document.querySelector('#export-canvas-guard')?.classList.remove('guard-on');
    }, [addToBatch, getCardBlob, isBatchDownloading, onDownloadError, resolution]);

    const download = useCallback(async (size: [number, number] = resolution) => {
        try {
            const normalizedName = normalizeCardName(name);
            const cardData = await getCardDataUrl(size);
            if (typeof cardData !== 'string') throw new Error('Failed to trigger automatic download');
            const link = document.createElement('a');
            link.download = normalizedName
                ? `${normalizedName}.png`
                : 'card.png';
            link.href = cardData;
            link.click();
        } catch (e) {
            onDownloadError();
        }
        document.querySelector('#export-canvas-guard')?.classList.remove('guard-on');
        onDownloadComplete();
    }, [resolution, onDownloadComplete, name, getCardDataUrl, onDownloadError]);

    const onSave = (size?: [number, number]) => {
        document.querySelector('#export-canvas-guard')?.classList.add('guard-on');
        const queuingSize = size ? [...size] as [number, number] : undefined;
        /** Prevent split-second download. By using hotkey user is able to perform extremely fast save process before the pipeline start running, thus getting the previous card data instead of the most recent one. */
        setTimeout(() => {
            if (exportRef.current.pipelineRunning === false) {
                download(queuingSize);
            } else pendingSave.current = true;
        }, 200);
    };

    useEffect(() => {
        let relevant = true;
        setTimeout(() => {
            if (relevant) {
                document.title = normalizedName
                    ? `${normalizedName} - Yu-Gi-Oh Carder`
                    : 'Yu-Gi-Oh Carder';
            }
        }, 500);

        return () => {
            relevant = false;
        };
    }, [normalizedName]);

    useEffect(() => {
        const saveCardToLocalForPagehide = (event: PageTransitionEvent) => {
            if (event.persisted) return; // bfcache
            saveCardLocally(useCard.getState().card);
        };

        window.addEventListener('pagehide', saveCardToLocalForPagehide);

        return () => {
            window.removeEventListener('pagehide', saveCardToLocalForPagehide);
        };
    }, []);

    const drawCounter = useRef(0);
    useEffect(() => {
        drawCounter.current += 1;
        const thisCounter = drawCounter.current;
        const confirmReload = (ev: Event) => {
            ev.preventDefault();
            return language['prompt.warning.on-leave.label'];
        };
        if (isInitializing === false) {
            (async () => {
                const canvasRef = exportCanvasRef.current;
                if (canvasRef) {
                    window.addEventListener('beforeunload', confirmReload);
                    document.getElementById('export-canvas')?.classList.remove('js-export-available');
                    document.getElementById('preview-canvas')?.classList.remove('js-export-available');
                    document.getElementById('export-canvas-guard')?.setAttribute('style', '');
                    document.getElementById('save-button-waiting')?.setAttribute('style', 'display: block');

                    exportRef.current.pipelineRunning = true;
                    await exportRef.current.currentPipeline;

                    // 🔧 FIX batch: attendre que la nouvelle image d'art soit chargée ET redessinée
                    // AVANT de dessiner le canvas d'export (sinon il reprend l'art de la carte précédente).
                    if (isBatchDownloading && !batchDataMap[currentCard.id]) {
                        await waitForArtReady();
                    }

                    if (thisCounter === drawCounter.current) {
                        exportRef.current.currentPipeline = onExport({
                            isPendulum,
                            opacity,
                            pendulumSize,
                            isRelevant: () => {
                                return thisCounter === drawCounter.current;
                            },
                        });

                        await exportRef.current.currentPipeline;
                        if (thisCounter === drawCounter.current) {
                            const normalizedCard = {
                                ...currentCard,
                                artData: '',
                                backgroundData: '',
                                overlayData: '',
                                iconImageData: '',
                                attributeImageData: '',
                            };
                            const condensedCard = JSON.stringify(compressCardData(normalizedCard));
                            const maxDataLength = 8192;
                            if (typeof condensedCard === 'string' && condensedCard.length <= maxDataLength) {
                                insertUrlParam([{ key: 'data', value: condensedCard }]);
                            } else {
                                insertUrlParam([{ key: 'data-type', value: 'local' }], 'replace');
                            }

                            document.getElementById('export-canvas')?.classList.add('js-export-available');
                            document.getElementById('preview-canvas')?.classList.add('js-export-available');
                            document.getElementById('export-canvas-guard')?.setAttribute('style', 'display: none');
                            document.getElementById('save-button-waiting')?.setAttribute('style', 'display: none');
                            saveCardLocally(useCard.getState().card);
                            window.removeEventListener('beforeunload', confirmReload);

                            // Batch capture: wait for paint, then snapshot, THEN release pipeline.
                            if (isBatchDownloading && !batchDataMap[normalizedCard.id]) {
                                await addToCurrentBatch(
                                    exportScheme === 'with-name'
                                        ? `${normalizedName}.png`
                                        : `${normalizedCard.setId} - ${normalizedName}.png`,
                                    normalizedCard.id,
                                );
                            }

                            exportRef.current.pipelineRunning = false;

                            if (pendingSave.current) {
                                pendingSave.current = false;
                                download();
                            }
                        }
                    }
                }
            })();
        }

        return () => {
            window.removeEventListener('beforeunload', confirmReload);
        };
    });

    return {
        onSave,
        isPipelineRunning: () => exportRef.current.pipelineRunning,
    };
};
